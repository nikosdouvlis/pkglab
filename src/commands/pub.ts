import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { discoverWorkspace, findPackage } from "../lib/workspace";
import { buildDependencyGraph, computeCascade } from "../lib/graph";
import { buildPublishPlan, executePublish } from "../lib/publisher";
import { generateVersion } from "../lib/version";
import { acquirePublishLock } from "../lib/lock";
import { log } from "../lib/log";
import { DaemonNotRunningError } from "../lib/errors";

export default defineCommand({
  meta: { name: "pub", description: "Publish packages to local Verdaccio" },
  args: {
    name: { type: "positional", description: "Package name", required: false },
    "dry-run": { type: "boolean", description: "Show what would be published", default: false },
    fast: { type: "boolean", description: "Skip dep cascade", default: false },
  },
  async run({ args }) {
    const status = await getDaemonStatus();
    if (!status?.running) {
      throw new DaemonNotRunningError();
    }

    const config = await loadConfig();
    const workspace = await discoverWorkspace(process.cwd());
    log.info(`Found ${workspace.packages.length} packages in workspace`);

    const graph = buildDependencyGraph(workspace.packages);

    let targets: string[];
    if (args.name) {
      const pkg = findPackage(workspace.packages, args.name as string);
      if (!pkg) {
        log.error(`Package not found in workspace: ${args.name}`);
        process.exit(1);
      }
      targets = [pkg.name];
    } else {
      targets = workspace.packages.map((p) => p.name);
    }

    let publishSet;
    if (args.fast) {
      publishSet = targets
        .map((name) => findPackage(workspace.packages, name))
        .filter(Boolean) as typeof workspace.packages;
    } else {
      publishSet = computeCascade(graph, targets);
    }

    const version = generateVersion();
    const plan = buildPublishPlan(publishSet, version);

    if (args["dry-run"]) {
      log.info("Dry run - would publish:");
      for (const entry of plan.packages) {
        log.line(`  ${entry.name}@${entry.version}`);
        for (const [dep, ver] of Object.entries(entry.rewrittenDeps)) {
          log.dim(`    ${dep} -> ${ver}`);
        }
      }
      return;
    }

    const releaseLock = await acquirePublishLock();
    try {
      await executePublish(plan, config);

      log.success(`Published ${plan.packages.length} packages:`);
      for (const entry of plan.packages) {
        log.line(`  ${entry.name}@${entry.version}`);
      }

      // Auto-update active consumer repos
      const { getActiveRepos, saveRepoState: saveRepo } = await import("../lib/repo-state");
      const { detectPackageManager } = await import("../lib/pm-detect");
      const { updatePackageJsonVersion, scopedInstall } = await import("../lib/consumer");

      const activeRepos = await getActiveRepos();
      if (activeRepos.length > 0) {
        log.info("\nUpdating active repos:");
        for (const { name, state } of activeRepos) {
          const pm = await detectPackageManager(state.path);
          const updated: string[] = [];

          for (const entry of plan.packages) {
            if (state.packages[entry.name]) {
              await updatePackageJsonVersion(state.path, entry.name, entry.version);
              await scopedInstall(state.path, entry.name, entry.version, pm);
              state.packages[entry.name].current = entry.version;
              updated.push(entry.name);
            }
          }

          if (updated.length > 0) {
            await saveRepo(name, state);
            log.success(`  ${name}: updated ${updated.join(", ")}`);
          }
        }
      }
    } finally {
      await releaseLock();
    }
  },
});
