import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { discoverWorkspace, findPackage, loadCatalogs } from "../lib/workspace";
import { buildDependencyGraph, computeCascade } from "../lib/graph";
import { buildPublishPlan, executePublish } from "../lib/publisher";
import { setDistTag } from "../lib/registry";
import { generateVersion, sanitizeTag } from "../lib/version";
import { acquirePublishLock } from "../lib/lock";
import { getActiveRepos } from "../lib/repo-state";
import { log } from "../lib/log";
import { c } from "../lib/color";
import { createMultiSpinner } from "../lib/spinner";
import { DaemonNotRunningError, pkglabError } from "../lib/errors";
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
    name: { type: "positional", description: "Package name", required: false },
    "dry-run": { type: "boolean", description: "Show what would be published", default: false },
    single: { type: "boolean", description: "Skip dep cascade", default: false },
    verbose: { type: "boolean", description: "Show detailed output", default: false, alias: "v" },
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

    const status = await getDaemonStatus();
    if (!status?.running) {
      throw new DaemonNotRunningError();
    }

    const config = await loadConfig();
    const workspace = await discoverWorkspace(process.cwd());
    if (verbose) {
      log.info(`Found ${workspace.packages.length} packages in workspace`);
    }

    const graph = buildDependencyGraph(workspace.packages);

    let targets: string[];
    if (args.name) {
      const pkg = findPackage(workspace.packages, args.name as string);
      if (!pkg) {
        log.error(`Package not found in workspace: ${args.name}`);
        process.exit(1);
      }
      if (!pkg.publishable) {
        log.error(`Package ${args.name} is private and cannot be published`);
        process.exit(1);
      }
      targets = [pkg.name];
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

    const cascade = computeCascade(graph, targets, consumedPackages);
    let cascadePackages = cascade.packages;

    // Skip private packages pulled in by cascade (they're dependents, not deps)
    const skippedPrivate = cascadePackages.filter((p) => !p.publishable);
    if (skippedPrivate.length > 0) {
      if (verbose) {
        for (const pkg of skippedPrivate) {
          log.warn(`Skipping private package ${pkg.name}`);
        }
      }
      cascadePackages = cascadePackages.filter((p) => p.publishable);
    }

    // Log cascade breakdown per target (verbose only)
    if (verbose) {
      for (const target of targets) {
        const deps = cascade.dependencies[target] || [];
        const depts = cascade.dependents[target] || [];

        if (deps.length > 0) {
          log.info(`${target} dependencies:`);
          for (const d of deps) log.line(`  - ${d}`);
        }

        if (depts.length > 0) {
          log.info(`${target} cascading up:`);
          for (const d of depts) {
            const dDeps = graph.directDependenciesOf(d)
              .filter((dep) => cascade.packages.some((p) => p.name === dep));
            log.line(`  - ${d} -> ${dDeps.join(", ")}`);
          }
        }
      }
    }

    // Log skipped dependents from consumer-aware filtering
    if (cascade.skippedDependents.length > 0) {
      if (verbose) {
        log.dim(`Skipped ${cascade.skippedDependents.length} unconsumed dependents: ${cascade.skippedDependents.join(", ")}`);
      } else {
        log.dim(`Skipped ${cascade.skippedDependents.length} unconsumed dependents`);
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

    // Fingerprint all packages in the cascade
    if (verbose) {
      log.info("Fingerprinting packages...");
    }
    const fingerprints = await fingerprintPackages(
      cascadePackages.map((p) => ({ name: p.name, dir: p.dir })),
    );

    // Load previous fingerprint state
    const previousState = await loadFingerprintState(workspace.root, tag ?? null);

    // Determine change status in topological order
    const { reason, existingVersions } = detectChanges(
      cascadePackages, fingerprints, previousState, graph,
    );

    const publishSet = cascadePackages.filter((p) => {
      const r = reason.get(p.name);
      return r === "changed" || r === "propagated";
    });
    const unchangedSet = cascadePackages.filter((p) => reason.get(p.name) === "unchanged");

    // Build scope reason lookup: target / dependency / dependent
    const targetSet = new Set(targets);
    const depSet = new Set<string>();
    const deptSet = new Set<string>();
    for (const target of targets) {
      for (const d of cascade.dependencies[target] || []) depSet.add(d);
      for (const d of cascade.dependents[target] || []) deptSet.add(d);
    }

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
      const scopeReason = targetSet.has(pkg.name) ? "target" : depSet.has(pkg.name) ? "dependency" : "dependent";
      const changeReason = r === "changed" ? "changed" : r === "propagated" ? "dep changed" : "unchanged";
      if (willPublish) {
        log.line(`  ${c.green("\u25B2")} ${pkg.name}  ${scopeReason}, ${changeReason}`);
      } else {
        log.line(`  ${c.dim("\u00B7")} ${c.dim(pkg.name)}  ${c.dim(`${scopeReason}, ${changeReason}`)}`);
      }
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
