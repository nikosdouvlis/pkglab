import { defineCommand } from "citty";
import { loadRepoState, deleteRepoState, loadAllRepos } from "../../lib/repo-state";
import {
  removeRegistryFromNpmrc,
  removeSkipWorktree,
  updatePackageJsonVersion,
} from "../../lib/consumer";
import { log } from "../../lib/log";
import type { RepoState } from "../../types";
import { exists } from "node:fs/promises";
import { join } from "node:path";

export default defineCommand({
  meta: { name: "reset", description: "Reset repo to original versions" },
  args: {
    name: { type: "positional", description: "Repo name", required: false },
    all: { type: "boolean", description: "Reset all repos", default: false },
    stale: { type: "boolean", description: "Remove repos whose directories no longer exist", default: false },
  },
  async run({ args }) {
    if (args.stale) {
      const allRepos = await loadAllRepos();
      let removed = 0;
      for (const [name, state] of Object.entries(allRepos)) {
        if (!(await exists(join(state.path, "package.json")))) {
          await deleteRepoState(name);
          log.success(`Removed stale repo: ${name} (${state.path})`);
          removed++;
        }
      }
      if (removed === 0) {
        log.info("No stale repos found");
      }
      return;
    }

    let targets: Array<[string, RepoState]>;

    if (args.all) {
      targets = Object.entries(await loadAllRepos());
    } else if (args.name) {
      const state = await loadRepoState(args.name as string);
      if (!state) {
        log.error(`Repo not found: ${args.name}`);
        process.exit(1);
      }
      targets = [[args.name as string, state]];
    } else {
      log.error("Specify a repo name, --all, or --stale");
      process.exit(1);
    }

    for (const [name, state] of targets) {
      const pkgJsonExists = await exists(join(state.path, "package.json"));
      if (!pkgJsonExists) {
        log.warn(`Skipping ${name}: directory or package.json no longer exists (${state.path})`);
        log.dim(`  Run --stale to remove it`);
        continue;
      }

      log.info(`Resetting ${name}...`);
      for (const [pkgName, link] of Object.entries(state.packages)) {
        if (link.original) {
          await updatePackageJsonVersion(state.path, pkgName, link.original);
          log.dim(`  ${pkgName} -> ${link.original}`);
        } else {
          // No original — remove the dependency
          const pkgJsonPath = join(state.path, "package.json");
          const pkgJson = await Bun.file(pkgJsonPath).json();
          for (const field of ["dependencies", "devDependencies"]) {
            if (pkgJson[field]?.[pkgName]) {
              delete pkgJson[field][pkgName];
            }
          }
          await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
          log.dim(`  ${pkgName} removed (no original version)`);
        }
      }

      await removeRegistryFromNpmrc(state.path);
      await removeSkipWorktree(state.path);
      await deleteRepoState(name);
      log.success(`Reset ${name}`);
    }
  },
});
