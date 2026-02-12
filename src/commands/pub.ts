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
} from "../lib/graph";
import { buildPublishPlan, executePublish } from "../lib/publisher";
import { setDistTag } from "../lib/registry";
import { generateVersion, sanitizeTag } from "../lib/version";
import { acquirePublishLock } from "../lib/lock";
import { getActiveRepos } from "../lib/repo-state";
import { log } from "../lib/log";
import { c } from "../lib/color";
import { createMultiSpinner } from "../lib/spinner";
import { pkglabError } from "../lib/errors";
import { fingerprintPackages } from "../lib/fingerprint";
import { loadFingerprintState, saveFingerprintState } from "../lib/fingerprint-state";
import type { WorkspacePackage } from "../types";

type ChangeReason = "changed" | "propagated" | "unchanged";

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

export default defineCommand({
  meta: { name: "pub", description: "Publish packages to local Verdaccio" },
  args: {
    name: { type: "positional", description: "Package name(s)", required: false },
    "dry-run": { type: "boolean", description: "Show what would be published", default: false },
    single: { type: "boolean", description: "Skip dep cascade", default: false },
    verbose: { type: "boolean", description: "Show detailed output", default: false, alias: "v" },
    force: { type: "boolean", description: "Ignore fingerprints (republish all)", default: false, alias: "f" },
    tag: { type: "string", description: "Publish with a tag", alias: "t" },
    worktree: { type: "boolean", description: "Auto-detect tag from git branch", default: false, alias: "w" },
  },
  async run({ args }) {
    const verbose = args.verbose as boolean;

    // Resolve tag from --tag or --worktree
    if (args.tag && args.worktree) {
      throw new pkglabError("Cannot use --tag and --worktree together");
    }

    let tag: string | undefined;
    if (args.worktree) {
      const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const branch = (await new Response(proc.stdout).text()).trim();
      if (branch === "HEAD") {
        throw new pkglabError("Cannot detect branch name, use --tag instead");
      }
      tag = sanitizeTag(branch);
    } else if (args.tag) {
      tag = sanitizeTag(args.tag as string);
    }

    if (verbose && tag) {
      log.info(`Publishing with tag: ${tag}`);
    }

    await ensureDaemonRunning();

    const config = await loadConfig();
    const workspace = await discoverWorkspace(process.cwd());
    if (verbose) {
      log.info(`Found ${workspace.packages.length} packages in workspace`);
    }

    const graph = buildDependencyGraph(workspace.packages);

    let targets: string[];
    const names = ((args as any)._ as string[] | undefined) ?? [];
    if (names.length > 0) {
      targets = [];
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
    } else {
      const cwd = process.cwd();
      const currentPkg = workspace.packages.find((p) => p.dir === cwd);
      if (currentPkg) {
        if (!currentPkg.publishable) {
          log.error("Current package is private and cannot be published");
          process.exit(1);
        }
        targets = [currentPkg.name];
        log.info(`Publishing from package dir: ${currentPkg.name}`);
      } else {
        targets = workspace.packages.filter((p) => p.publishable).map((p) => p.name);
      }
    }

    // --single bypasses cascade and fingerprinting entirely
    if (args.single) {
      const publishSet = targets
        .map((name) => findPackage(workspace.packages, name))
        .filter(Boolean) as typeof workspace.packages;

      await publishPackages(publishSet, [], workspace.root, config, tag, verbose, args["dry-run"] as boolean);
      return;
    }

    // Gather consumed packages from active repos for cascade filtering.
    // When consumers exist, skip dependents that no consumer has installed.
    let consumedPackages: Set<string> | undefined;
    const activeRepos = await getActiveRepos();
    if (activeRepos.length > 0) {
      consumedPackages = new Set<string>();
      for (const { state } of activeRepos) {
        for (const pkgName of Object.keys(state.packages)) {
          consumedPackages.add(pkgName);
        }
      }
      if (consumedPackages.size === 0) {
        consumedPackages = undefined;
      }
    }

    // Phase 1: targets + transitive deps (no dependents yet)
    const { scope: initialScope } = computeInitialScope(graph, targets);
    const scope = new Set(initialScope);

    // Track scope reasons: why each package is in scope
    const targetSet = new Set(targets);
    // Maps dependent name to the package that triggered its inclusion
    const expandedFrom = new Map<string, string>();
    // All skipped dependents across iterations
    let allSkippedDependents: string[] = [];

    // Load previous fingerprint state (--force uses empty state to republish all)
    const previousState = args.force
      ? {}
      : await loadFingerprintState(workspace.root, tag ?? null);

    // Cache fingerprints across iterations
    const fingerprints = new Map<string, { hash: string; fileCount: number }>();
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
      const closed = closeUnderDeps(graph, scope);
      for (const name of closed) scope.add(name);

      // Fingerprint any packages not yet fingerprinted
      const toFingerprint: { name: string; dir: string }[] = [];
      for (const name of scope) {
        if (!fingerprints.has(name)) {
          const pkg = graph.getNodeData(name);
          toFingerprint.push({ name: pkg.name, dir: pkg.dir });
        }
      }
      if (toFingerprint.length > 0) {
        if (verbose) {
          log.info(`Fingerprinting ${toFingerprint.length} packages...`);
        }
        const newFps = await fingerprintPackages(toFingerprint);
        for (const [name, fp] of newFps) {
          fingerprints.set(name, fp);
        }
      }

      // Toposort the full scope for detectChanges
      const ordered = deterministicToposort(graph, scope);
      const scopePackages = ordered.map((name) => graph.getNodeData(name));

      // Classify all packages in topo order
      ({ reason, existingVersions } = detectChanges(
        scopePackages, fingerprints, previousState, graph,
      ));

      // Find changed packages we haven't expanded from yet
      const toExpand: string[] = [];
      for (const [name, r] of reason) {
        if ((r === "changed" || r === "propagated") && !expandedSet.has(name)) {
          toExpand.push(name);
        }
      }

      if (toExpand.length === 0) break;

      // Expand dependents from newly changed packages
      const expansion = expandDependents(graph, toExpand, scope, consumedPackages);
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
      if (verbose) {
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
    allSkippedDependents = [...new Set(allSkippedDependents)]
      .filter((d) => !scope.has(d))
      .sort();

    // Final toposort of the complete scope
    const finalOrdered = deterministicToposort(graph, scope);
    let cascadePackages = finalOrdered.map((name) => graph.getNodeData(name));

    // Skip private packages pulled in by cascade
    const skippedPrivate = cascadePackages.filter((p) => !p.publishable);
    if (skippedPrivate.length > 0) {
      if (verbose) {
        for (const pkg of skippedPrivate) {
          log.warn(`Skipping private package ${pkg.name}`);
        }
      }
      cascadePackages = cascadePackages.filter((p) => p.publishable);
    }

    // Verbose cascade breakdown
    if (verbose) {
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

    // Scope summary
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
    for (const name of allSkippedDependents) {
      log.line(`  ${c.dim("\u00B7")} ${c.dim(name)}  ${c.dim("dependent, no consumers")}`);
    }

    if (publishSet.length === 0) {
      log.line("");
      log.success("Nothing to publish");
      return;
    }
    log.line("");

    await publishPackages(
      publishSet,
      unchangedSet,
      workspace.root,
      config,
      tag,
      verbose,
      args["dry-run"] as boolean,
      existingVersions,
      reason,
      fingerprints,
      cascadePackages,
    );
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

  const releaseLock = await acquirePublishLock();
  try {
    if (verbose) {
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
      await executePublish(plan, config, { verbose: true });
      log.success(`Published ${plan.packages.length} packages:`);
      for (const entry of plan.packages) {
        log.line(`  ${entry.name}@${entry.version}`);
      }
    } else {
      log.info("Publishing...");
      const spinner = createMultiSpinner(
        plan.packages.map((e) => `${e.name}@${e.version}`),
      );
      spinner.start();
      try {
        await executePublish(plan, config, {
          onPublished: (i) => spinner.complete(i),
          onFailed: (i) => spinner.fail(i),
        });
      } finally {
        spinner.stop();
      }
    }

    // Set npm dist-tags so `npm install pkg@tag` works against the local registry
    const distTag = tag ?? "pkglab";
    await Promise.all(
      plan.packages.map((e) => setDistTag(config, e.name, e.version, distTag)),
    );

    // Auto-update active consumer repos
    const { updateActiveRepos } = await import("../lib/consumer");
    await updateActiveRepos(plan, verbose, tag);

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
    const pruneEntry = new URL("../lib/prune-worker.ts", import.meta.url).pathname;
    Bun.spawn(["bun", "run", pruneEntry, String(config.port), String(config.prune_keep), ...(tag ? [tag] : [])], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    }).unref();
  } finally {
    await releaseLock();
  }
}
