import { defineCommand } from "citty";
import { ensureDaemonRunning } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { discoverWorkspace, findPackage, loadCatalogs } from "../lib/workspace";
import {
  buildDependencyGraph,
  computeInitialScope,
  expandDependents,
  closeUnderDeps,
  deterministicToposort,
  precomputeTransitiveDeps,
  precomputeTransitiveDependents,
} from "../lib/graph";
import { buildPublishPlan, executePublish } from "../lib/publisher";
import { setDistTag } from "../lib/registry";
import { generateVersion, sanitizeTag } from "../lib/version";
import { acquirePublishLock } from "../lib/lock";
import { getActiveRepos, saveRepoByPath } from "../lib/repo-state";
import { prefetchUpdateCheck } from "../lib/update-check";
import { log } from "../lib/log";
import { c } from "../lib/color";
import { createMultiSpinner } from "../lib/spinner";
import type { SpinnerLine } from "../lib/spinner";
import { pkglabError } from "../lib/errors";
import { fingerprintPackages } from "../lib/fingerprint";
import { loadFingerprintState, saveFingerprintState } from "../lib/fingerprint-state";
import { run } from "../lib/proc";
import { getPositionalArgs } from "../lib/args";
import { getListenerSocketPath, sendPing } from "../lib/listener-ipc";
import {
  buildConsumerWorkItems,
  buildVersionEntries,
  installWithVersionUpdates,
} from "../lib/consumer";
import type { RepoWorkItem } from "../lib/consumer";
import type { WorkspacePackage, PublishEntry } from "../types";

type ChangeReason = "changed" | "propagated" | "unchanged";

interface CascadeResult {
  cascadePackages: WorkspacePackage[];
  publishSet: WorkspacePackage[];
  unchangedSet: WorkspacePackage[];
  reason: Map<string, ChangeReason>;
  existingVersions: Map<string, string>;
  fingerprints: Map<string, { hash: string; fileCount: number }>;
  targetSet: Set<string>;
  expandedFrom: Map<string, string>;
  initialScope: Set<string>;
  allSkippedDependents: { name: string; via: string }[];
  activeRepos: Awaited<ReturnType<typeof getActiveRepos>>;
}

function detectChanges(
  cascadePackages: WorkspacePackage[],
  fingerprints: Map<string, { hash: string; fileCount: number }>,
  previousState: Record<string, { hash: string; version: string }>,
  graph: ReturnType<typeof buildDependencyGraph>,
): { reason: Map<string, ChangeReason>; existingVersions: Map<string, string> } {
  const reason = new Map<string, ChangeReason>();
  const existingVersions = new Map<string, string>();
  const cascadeNames = new Set(cascadePackages.map((p) => p.name));

  // Process in topological order (cascadePackages is already topo-sorted)
  for (const pkg of cascadePackages) {
    const fp = fingerprints.get(pkg.name);
    const prev = previousState[pkg.name];

    // Content hash changed or no previous state: mark as changed
    if (!fp || !prev || fp.hash !== prev.hash) {
      reason.set(pkg.name, "changed");
      continue;
    }

    // Content same, but check if any workspace dep in the cascade changed/propagated
    let depChanged = false;
    try {
      const deps = graph.directDependenciesOf(pkg.name);
      for (const dep of deps) {
        if (cascadeNames.has(dep)) {
          const depReason = reason.get(dep);
          if (depReason === "changed" || depReason === "propagated") {
            depChanged = true;
            break;
          }
        }
      }
    } catch {
      // Node not in graph, treat as no deps
    }

    if (depChanged) {
      reason.set(pkg.name, "propagated");
    } else {
      reason.set(pkg.name, "unchanged");
      existingVersions.set(pkg.name, prev.version);
    }
  }

  return { reason, existingVersions };
}

async function resolveTag(args: Record<string, unknown>): Promise<string | undefined> {
  if (args.tag && args.worktree) {
    throw new pkglabError("Cannot use --tag and --worktree together");
  }

  if (args.worktree) {
    const result = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
    });
    const branch = result.stdout.trim();
    if (branch === "HEAD") {
      throw new pkglabError("Cannot detect branch name, use --tag instead");
    }
    return sanitizeTag(branch);
  }

  if (args.tag) {
    return sanitizeTag(args.tag as string);
  }

  return undefined;
}

function resolveTargets(
  args: Record<string, unknown>,
  workspace: { packages: WorkspacePackage[] },
): string[] {
  const names = getPositionalArgs(args);

  if (args.root && names.length > 0) {
    throw new pkglabError("Cannot use --root with package names");
  }

  if (names.length > 0) {
    const targets: string[] = [];
    for (const name of names) {
      const pkg = findPackage(workspace.packages, name);
      if (!pkg) {
        log.error(`Package not found in workspace: ${name}`);
        process.exit(1);
      }
      if (!pkg.publishable) {
        log.error(`Package ${name} is private and cannot be published`);
        process.exit(1);
      }
      targets.push(pkg.name);
    }
    return targets;
  }

  if (!args.root) {
    const cwd = process.cwd();
    const currentPkg = workspace.packages.find((p) => p.dir === cwd);
    if (currentPkg) {
      if (!currentPkg.publishable) {
        log.error("Current package is private and cannot be published");
        process.exit(1);
      }
      log.info(`Publishing from package dir: ${currentPkg.name}`);
      return [currentPkg.name];
    }
  }

  return workspace.packages.filter((p) => p.publishable).map((p) => p.name);
}

async function runCascade(
  targets: string[],
  workspace: { root: string; packages: WorkspacePackage[] },
  tag: string | undefined,
  opts: { verbose: boolean; shallow: boolean; force: boolean },
): Promise<CascadeResult> {
  const graph = buildDependencyGraph(workspace.packages);

  // Precompute transitive closures once for the entire graph
  const cachedDeps = precomputeTransitiveDeps(graph);
  const cachedDependents = precomputeTransitiveDependents(graph);

  // Gather consumed packages from active repos for cascade filtering.
  // No active repos = empty set = no dependents pass filter (nobody is consuming).
  // Active repos = filter dependents to only packages consumers have installed.
  const consumedPackages = new Set<string>();
  const activeRepos = await getActiveRepos();
  for (const { state } of activeRepos) {
    for (const pkgName of Object.keys(state.packages)) {
      consumedPackages.add(pkgName);
    }
  }

  // Phase 1: targets + transitive deps (no dependents yet)
  const { scope: initialScope } = computeInitialScope(graph, targets, cachedDeps);
  const scope = new Set(initialScope);

  // Track scope reasons: why each package is in scope
  const targetSet = new Set(targets);
  // Maps dependent name to the package that triggered its inclusion
  const expandedFrom = new Map<string, string>();
  // All skipped dependents across iterations (name + which package triggered them)
  let allSkippedDependents: { name: string; via: string }[] = [];

  // Load previous fingerprint state (--force uses empty state to republish all)
  const previousState = opts.force
    ? {}
    : await loadFingerprintState(workspace.root, tag ?? null);

  // Eager fingerprinting: fingerprint ALL publishable packages upfront in one parallel batch.
  // The cost of fingerprinting a few extra packages is negligible compared to eliminating
  // sequential rounds of fingerprinting inside the cascade loop.
  const allPublishable = workspace.packages.filter((p) => p.publishable);
  if (opts.verbose) {
    log.info(`Fingerprinting ${allPublishable.length} packages...`);
  }
  const fingerprints = await fingerprintPackages(
    allPublishable.map((p) => ({ name: p.name, dir: p.dir })),
  );

  // Track which changed packages we've already expanded dependents from
  const expandedSet = new Set<string>();
  // Track reason and existingVersions across iterations
  let reason = new Map<string, ChangeReason>();
  let existingVersions = new Map<string, string>();

  // Verbose: log initial scope
  const verboseExpansions: { source: string; newPackages: string[] }[] = [];

  // Two-phase cascade loop
  while (true) {
    // Close under deps: ensure every publishable package has its workspace deps in scope
    const closed = closeUnderDeps(graph, scope, cachedDeps);
    for (const name of closed) scope.add(name);

    // Toposort the full scope for detectChanges
    const ordered = deterministicToposort(graph, scope);
    const scopePackages = ordered.map((name) => graph.getNodeData(name));

    // Classify all packages in topo order
    ({ reason, existingVersions } = detectChanges(
      scopePackages, fingerprints, previousState, graph,
    ));

    // --shallow: skip dependent expansion (targets + deps only)
    if (opts.shallow) break;

    // Find changed packages we haven't expanded from yet
    const toExpand: string[] = [];
    for (const [name, r] of reason) {
      if (r === "changed" && !expandedSet.has(name)) {
        toExpand.push(name);
      }
    }

    if (toExpand.length === 0) break;

    // Expand dependents from newly changed packages
    const expansion = expandDependents(graph, toExpand, scope, consumedPackages, cachedDependents);
    for (const name of toExpand) expandedSet.add(name);

    // Track which package triggered each dependent's inclusion
    for (const source of toExpand) {
      for (const dep of expansion.dependents[source] || []) {
        if (!scope.has(dep) && !expandedFrom.has(dep)) {
          expandedFrom.set(dep, source);
        }
      }
    }

    // Collect skipped dependents
    if (expansion.skippedDependents.length > 0) {
      allSkippedDependents = allSkippedDependents.concat(expansion.skippedDependents);
    }

    if (expansion.newPackages.length === 0) break;

    // Log expansion for verbose output
    if (opts.verbose) {
      for (const source of toExpand) {
        const newFromSource = (expansion.dependents[source] || [])
          .filter((d) => !scope.has(d));
        if (newFromSource.length > 0) {
          verboseExpansions.push({ source, newPackages: newFromSource });
        }
      }
    }

    // Add new packages to scope
    for (const name of expansion.newPackages) {
      scope.add(name);
    }
  }

  // Deduplicate skipped dependents
  const seenSkipped = new Set<string>();
  allSkippedDependents = allSkippedDependents
    .filter((d) => {
      if (scope.has(d.name) || seenSkipped.has(d.name)) return false;
      seenSkipped.add(d.name);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Final toposort of the complete scope
  const finalOrdered = deterministicToposort(graph, scope);
  let cascadePackages = finalOrdered.map((name) => graph.getNodeData(name));

  // Skip private packages pulled in by cascade
  const skippedPrivate = cascadePackages.filter((p) => !p.publishable);
  if (skippedPrivate.length > 0) {
    if (opts.verbose) {
      for (const pkg of skippedPrivate) {
        log.warn(`Skipping private package ${pkg.name}`);
      }
    }
    cascadePackages = cascadePackages.filter((p) => p.publishable);
  }

  // Verbose cascade breakdown
  if (opts.verbose) {
    const initialNames = [...initialScope].sort();
    const depsInInitial = initialNames.filter((n) => !targetSet.has(n));
    const initialParts = targets.concat(depsInInitial.map((n) => `${n} (dep)`));
    log.info(`Initial scope: ${initialParts.join(", ")}`);
    for (const { source, newPackages } of verboseExpansions) {
      const sourceReason = reason.get(source) === "changed" ? "changed" : "dep changed";
      log.info(`Expanded from ${source} (${sourceReason}):`);
      for (const d of newPackages) log.line(`  - ${d}`);
    }
  }

  // Validate no non-publishable dependencies in the cascade set
  for (const pkg of cascadePackages) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      const deps = pkg.packageJson[field];
      if (!deps) continue;
      for (const depName of Object.keys(deps)) {
        const depPkg = workspace.packages.find((p) => p.name === depName);
        if (depPkg && !depPkg.publishable) {
          log.error(`Cannot publish ${pkg.name}: depends on private package ${depName}`);
          process.exit(1);
        }
      }
    }
  }

  const publishSet = cascadePackages.filter((p) => {
    const r = reason.get(p.name);
    return r === "changed" || r === "propagated";
  });
  const unchangedSet = cascadePackages.filter((p) => reason.get(p.name) === "unchanged");

  return {
    cascadePackages,
    publishSet,
    unchangedSet,
    reason,
    existingVersions,
    fingerprints,
    targetSet,
    expandedFrom,
    initialScope,
    allSkippedDependents,
    activeRepos,
  };
}

function printScopeSummary(
  cascade: CascadeResult,
): void {
  const {
    cascadePackages, publishSet, unchangedSet, reason,
    targetSet, expandedFrom, initialScope, allSkippedDependents, activeRepos,
  } = cascade;

  const toPublish = publishSet.length;
  const unchanged = unchangedSet.length;
  const total = cascadePackages.length;
  const parts = [`${toPublish} to publish`];
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  log.info(`Scope: ${total} packages (${parts.join(", ")})`);
  log.line("");

  for (const pkg of cascadePackages) {
    const r = reason.get(pkg.name)!;
    const willPublish = r === "changed" || r === "propagated";

    // Scope reason: target, dependency (transitive dep of target), or dependent (via X)
    let scopeReason: string;
    if (targetSet.has(pkg.name)) {
      scopeReason = "target";
    } else if (expandedFrom.has(pkg.name)) {
      scopeReason = `dependent (via ${expandedFrom.get(pkg.name)})`;
    } else if (initialScope.has(pkg.name)) {
      scopeReason = "dependency";
    } else {
      scopeReason = "dependency";
    }

    const changeReason = r === "changed" ? "changed" : r === "propagated" ? "dep changed" : "unchanged";
    if (willPublish) {
      log.line(`  ${c.green("\u25B2")} ${pkg.name}  ${scopeReason}, ${changeReason}`);
    } else {
      log.line(`  ${c.dim("\u00B7")} ${c.dim(pkg.name)}  ${c.dim(`${scopeReason}, ${changeReason}`)}`);
    }
  }

  if (activeRepos.length > 0) {
    for (const { name, via } of allSkippedDependents) {
      log.line(`  ${c.dim("\u00B7")} ${c.dim(name)}  ${c.dim(`dependent (via ${via}), no consumers`)}`);
    }
  }
}

export default defineCommand({
  meta: { name: "pub", description: "Publish packages to local registry" },
  args: {
    name: { type: "positional", description: "Package name(s)", required: false },
    "dry-run": { type: "boolean", description: "Show what would be published", default: false },
    single: { type: "boolean", description: "Skip dep cascade", default: false },
    shallow: { type: "boolean", description: "Targets + deps only, no dependent expansion", default: false },
    verbose: { type: "boolean", description: "Show detailed output", default: false, alias: "v" },
    force: { type: "boolean", description: "Ignore fingerprints (republish all)", default: false, alias: "f" },
    tag: { type: "string", description: "Publish with a tag", alias: "t" },
    worktree: { type: "boolean", description: "Auto-detect tag from git branch", default: false, alias: "w" },
    root: { type: "boolean", description: "Publish all packages (skip per-package cwd detection)", default: false },
    ping: { type: "boolean", description: "Send signal to listener instead of publishing", default: false },
  },
  async run({ args }) {
    const verbose = args.verbose as boolean;
    const showUpdate = await prefetchUpdateCheck();

    const tag = await resolveTag(args);
    if (verbose && tag) {
      log.info(`Publishing with tag: ${tag}`);
    }

    await ensureDaemonRunning();

    const config = await loadConfig();
    const workspace = await discoverWorkspace(process.cwd());
    if (verbose) {
      log.info(`Found ${workspace.packages.length} packages in workspace`);
    }

    const targets = resolveTargets(args, workspace);

    // --ping: send signal to the listener and exit
    if (args.ping) {
      const socketPath = getListenerSocketPath(workspace.root);
      await sendPing(socketPath, {
        names: targets,
        tag,
        root: args.root as boolean,
      });
      log.success("Ping sent to listener");
      return;
    }

    // --single bypasses cascade and fingerprinting entirely
    if (args.single) {
      const publishSet = targets
        .map((name) => findPackage(workspace.packages, name))
        .filter(Boolean) as typeof workspace.packages;

      await publishPackages(publishSet, [], workspace.root, config, tag, verbose, args["dry-run"] as boolean, new Map(), undefined, undefined, undefined, workspace.packages);
      await showUpdate();
      return;
    }

    const cascade = await runCascade(targets, workspace, tag, {
      verbose,
      shallow: args.shallow as boolean,
      force: args.force as boolean,
    });

    printScopeSummary(cascade);

    if (cascade.publishSet.length === 0) {
      log.line("");
      log.success("Nothing to publish");
      await showUpdate();
      return;
    }
    log.line("");

    await publishPackages(
      cascade.publishSet,
      cascade.unchangedSet,
      workspace.root,
      config,
      tag,
      verbose,
      args["dry-run"] as boolean,
      cascade.existingVersions,
      cascade.reason,
      cascade.fingerprints,
      cascade.cascadePackages,
      workspace.packages,
    );
    await showUpdate();
  },
});

async function publishPackages(
  publishSet: WorkspacePackage[],
  unchangedSet: WorkspacePackage[],
  workspaceRoot: string,
  config: { port: number; prune_keep: number },
  tag: string | undefined,
  verbose: boolean,
  dryRun: boolean,
  existingVersions: Map<string, string> = new Map(),
  reason?: Map<string, ChangeReason>,
  fingerprints?: Map<string, { hash: string; fileCount: number }>,
  allCascadePackages?: WorkspacePackage[],
  workspacePackages?: WorkspacePackage[],
): Promise<void> {
  const catalogs = await loadCatalogs(workspaceRoot);

  if (dryRun) {
    const version = generateVersion(tag);
    const plan = buildPublishPlan(publishSet, version, catalogs, existingVersions);

    // Scope summary already printed for cascade path; show "Will publish" only for --single
    if (!reason) {
      log.info(`Will publish ${plan.packages.length} packages:`);
    }
    for (const entry of plan.packages) {
      const r = reason?.get(entry.name);
      if (verbose && r) {
        const detail = r === "propagated" ? " (dep changed)" : " (content changed)";
        log.line(`  ${c.green("\u2714")} ${entry.name}@${entry.version}${detail}`);
      } else {
        log.line(`  ${c.green("\u2714")} ${entry.name}@${entry.version}`);
      }
    }
    for (const pkg of unchangedSet) {
      const ver = existingVersions.get(pkg.name) ?? "unknown";
      log.line(`  ${c.dim("\u25CB")} ${c.dim(`${pkg.name} (unchanged, ${ver})`)}`);
    }
    return;
  }

  const version = generateVersion(tag);
  const plan = buildPublishPlan(publishSet, version, catalogs, existingVersions);

  // Scope summary already printed for cascade path; show "Will publish" only for --single
  if (!reason) {
    log.info(`Will publish ${plan.packages.length} packages:`);
  }

  // Build consumer work items before publishing so we can stream installs
  const consumerWork = await buildConsumerWorkItems(plan, tag);

  // Compute the required set for each repo: which packages from the publish batch
  // must be in the registry before the repo's install can succeed.
  // This includes direct packages and their transitive workspace deps.
  const requiredSets = new Map<RepoWorkItem, Set<string>>();
  if (consumerWork.length > 0 && workspacePackages) {
    const graph = buildDependencyGraph(workspacePackages);
    const transitiveDeps = precomputeTransitiveDeps(graph);
    const publishNames = new Set(plan.packages.map((p) => p.name));

    for (const repo of consumerWork) {
      const required = new Set<string>();
      for (const entry of repo.packages) {
        if (publishNames.has(entry.name)) {
          required.add(entry.name);
        }
        const deps = transitiveDeps.get(entry.name) ?? [];
        for (const dep of deps) {
          if (publishNames.has(dep)) {
            required.add(dep);
          }
        }
      }
      requiredSets.set(repo, required);
    }
  }

  const releaseLock = await acquirePublishLock();
  try {
    const publishStart = performance.now();

    if (verbose) {
      // Verbose mode: log messages as they happen, no unified spinner
      for (const entry of plan.packages) {
        const r = reason?.get(entry.name);
        if (r) {
          const detail = r === "propagated" ? " (dep changed)" : " (content changed)";
          log.line(`  ${c.green("\u2714")} ${entry.name}@${entry.version}${detail}`);
        } else {
          log.line(`  - ${entry.name}@${entry.version}`);
        }
      }
      for (const pkg of unchangedSet) {
        const ver = existingVersions.get(pkg.name) ?? "unknown";
        log.line(`  ${c.dim("\u25CB")} ${c.dim(`${pkg.name} (unchanged, ${ver})`)}`);
      }

      // Streaming consumer updates in verbose mode
      const publishedPackages = new Set<string>();
      const pendingRepos = new Set(consumerWork);
      const repoInstallPromises: Promise<void>[] = [];

      await executePublish(plan, config, {
        verbose: true,
        onPackagePublished(entry: PublishEntry) {
          publishedPackages.add(entry.name);
          for (const repo of pendingRepos) {
            const required = requiredSets.get(repo);
            if (!required) continue;
            const allReady = [...required].every((name) => publishedPackages.has(name));
            if (allReady) {
              pendingRepos.delete(repo);
              log.info(`Starting install for ${repo.displayName}`);
              repoInstallPromises.push(
                runRepoInstall(repo).then(() => {
                  log.success(`  ${repo.displayName}: updated ${repo.packages.map((e) => e.name).join(", ")}`);
                }),
              );
            }
          }
        },
      }, workspaceRoot);

      // Mark repos that depend on failed packages
      for (const repo of pendingRepos) {
        const required = requiredSets.get(repo);
        if (required) {
          const missing = [...required].filter((name) => !publishedPackages.has(name));
          if (missing.length > 0) {
            log.warn(`Skipped ${repo.displayName} (publish failed for ${missing.join(", ")})`);
          }
        }
      }

      // Wait for any in-flight consumer installs
      await Promise.all(repoInstallPromises);
    } else {
      // Non-verbose: unified spinner with publish lines + consumer repo lines
      log.info("Publishing...");
      const spinnerLines: SpinnerLine[] = plan.packages.map(
        (e) => `${e.name}@${e.version}`,
      );

      // Add consumer repo lines to the spinner (header + per-package lines)
      const repoPackageIndices = new Map<RepoWorkItem, number[]>();

      for (const repo of consumerWork) {
        spinnerLines.push({ text: `${repo.displayName} ${c.dim(repo.state.path)}`, header: true });
        const indices: number[] = [];
        for (const entry of repo.packages) {
          indices.push(spinnerLines.length);
          spinnerLines.push(`waiting for ${entry.name}`);
        }
        repoPackageIndices.set(repo, indices);
      }

      const spinner = createMultiSpinner(spinnerLines);
      spinner.start();

      const publishedPackages = new Set<string>();
      const pendingRepos = new Set(consumerWork);
      const repoInstallPromises: Promise<void>[] = [];

      try {
        await executePublish(plan, config, {
          onPublished: (i) => spinner.complete(i),
          onFailed: (i) => spinner.fail(i),
          onPackagePublished(entry: PublishEntry) {
            publishedPackages.add(entry.name);
            for (const repo of pendingRepos) {
              const required = requiredSets.get(repo);
              if (!required) continue;
              const allReady = [...required].every((name) => publishedPackages.has(name));
              if (allReady) {
                pendingRepos.delete(repo);
                const indices = repoPackageIndices.get(repo)!;
                for (const idx of indices) {
                  spinner.setText(idx, `installing ${repo.packages[indices.indexOf(idx)].name}`);
                }
                repoInstallPromises.push(
                  runRepoInstall(repo).then(() => {
                    for (let i = 0; i < repo.packages.length; i++) {
                      spinner.setText(indices[i], `updated ${repo.packages[i].name}`);
                      spinner.complete(indices[i]);
                    }
                  }).catch((err) => {
                    for (const idx of indices) {
                      spinner.fail(idx);
                    }
                    throw err;
                  }),
                );
              }
            }
          },
        }, workspaceRoot);

        // Mark repos that depend on failed packages
        for (const repo of pendingRepos) {
          const required = requiredSets.get(repo);
          if (!required) continue;
          const missing = [...required].filter((name) => !publishedPackages.has(name));
          if (missing.length > 0) {
            const indices = repoPackageIndices.get(repo)!;
            for (let i = 0; i < repo.packages.length; i++) {
              spinner.setText(indices[i], `skipped ${repo.packages[i].name}`);
              spinner.fail(indices[i]);
            }
          }
        }

        // Wait for any in-flight consumer installs
        await Promise.all(repoInstallPromises);
      } finally {
        spinner.stop();
      }
    }

    // Set npm dist-tags so `npm install pkg@tag` works against the local registry
    const distTag = tag ?? "pkglab";
    await Promise.all(
      plan.packages.map((e) => setDistTag(config, e.name, e.version, distTag)),
    );

    const elapsed = ((performance.now() - publishStart) / 1000).toFixed(2);
    log.success(`Published ${plan.packages.length} packages in ${elapsed}s`);

    // Save fingerprint state AFTER consumer updates so a failed update retries on next pub
    if (fingerprints && allCascadePackages) {
      const entries = allCascadePackages.map((pkg) => {
        const fp = fingerprints.get(pkg.name);
        const pkgVersion = existingVersions.get(pkg.name) ?? version;
        return {
          name: pkg.name,
          hash: fp?.hash ?? "",
          version: pkgVersion,
        };
      });
      await saveFingerprintState(workspaceRoot, tag ?? null, entries);
    }

    // Auto-prune old versions in detached subprocess
    Bun.spawn([process.execPath, "--__prune", String(config.port), String(config.prune_keep), ...(tag ? [tag] : [])], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    }).unref();
  } finally {
    await releaseLock();
  }
}

async function runRepoInstall(
  repo: RepoWorkItem,
): Promise<void> {
  const { entries, catalogRoot } = await buildVersionEntries(repo);

  await installWithVersionUpdates({
    repoPath: repo.state.path,
    catalogRoot,
    entries,
    pm: repo.pm,
  });

  for (const entry of repo.packages) {
    repo.state.packages[entry.name].current = entry.version;
  }
  await saveRepoByPath(repo.state.path, repo.state);
}
