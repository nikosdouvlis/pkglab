import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { discoverWorkspace, findPackage, loadCatalogs } from "../lib/workspace";
import { buildDependencyGraph, computeCascade } from "../lib/graph";
import { buildPublishPlan, executePublish } from "../lib/publisher";
import { generateVersion } from "../lib/version";
import { acquirePublishLock } from "../lib/lock";
import { log } from "../lib/log";
import { createMultiSpinner } from "../lib/spinner";
import { DaemonNotRunningError } from "../lib/errors";

export default defineCommand({
  meta: { name: "pub", description: "Publish packages to local Verdaccio" },
  args: {
    name: { type: "positional", description: "Package name", required: false },
    "dry-run": { type: "boolean", description: "Show what would be published", default: false },
    fast: { type: "boolean", description: "Skip dep cascade", default: false },
    verbose: { type: "boolean", description: "Show detailed output", default: false, alias: "v" },
  },
  async run({ args }) {
    const verbose = args.verbose as boolean;
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
      targets = [pkg.name];
    } else {
      const cwd = process.cwd();
      const currentPkg = workspace.packages.find((p) => p.dir === cwd);
      if (currentPkg) {
        targets = [currentPkg.name];
        log.info(`Publishing from package dir: ${currentPkg.name}`);
      } else {
        targets = workspace.packages.map((p) => p.name);
      }
    }

    let publishSet: typeof workspace.packages;
    if (args.fast) {
      publishSet = targets
        .map((name) => findPackage(workspace.packages, name))
        .filter(Boolean) as typeof workspace.packages;
    } else {
      const cascade = computeCascade(graph, targets);
      publishSet = cascade.packages;

      // Log cascade breakdown per target
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

    // Seed version monotonicity from registry
    const { seedTimestamp } = await import("../lib/version");
    const { getPackageVersions } = await import("../lib/registry");
    for (const pkg of publishSet) {
      const versions = await getPackageVersions(config, pkg.name);
      seedTimestamp(versions);
    }

    const version = generateVersion();
    const catalogs = await loadCatalogs(workspace.root);
    const plan = buildPublishPlan(publishSet, version, catalogs);

    log.info(`Will publish ${plan.packages.length} packages:`);

    if (args["dry-run"]) {
      for (const entry of plan.packages) {
        log.line(`  - ${entry.name}@${entry.version}`);
      }
      return;
    }

    const releaseLock = await acquirePublishLock();
    try {
      if (verbose) {
        for (const entry of plan.packages) {
          log.line(`  - ${entry.name}@${entry.version}`);
        }
        await executePublish(plan, config, { verbose: true });
        log.success(`Published ${plan.packages.length} packages:`);
        for (const entry of plan.packages) {
          log.line(`  ${entry.name}@${entry.version}`);
        }
      } else {
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
              await saveRepo(name, state);
              updated.push(entry.name);
            }
          }

          if (updated.length > 0) {
            log.success(`  ${name}: updated ${updated.join(", ")}`);
          }
        }
      }

      // Auto-prune old versions in detached subprocess
      const pruneEntry = new URL("../lib/prune-worker.ts", import.meta.url).pathname;
      Bun.spawn(["bun", "run", pruneEntry, String(config.port), String(config.prune_keep)], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      }).unref();
    } finally {
      await releaseLock();
    }
  },
});
