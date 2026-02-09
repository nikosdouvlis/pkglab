import { defineCommand } from "citty";
import { loadRepoState, saveRepoState, loadAllRepos } from "../../lib/repo-state";
import {
  removeRegistryFromNpmrc,
  removeSkipWorktree,
  updatePackageJsonVersion,
} from "../../lib/consumer";
import { log } from "../../lib/log";
import type { RepoState } from "../../types";

export default defineCommand({
  meta: { name: "reset", description: "Reset repo to original versions" },
  args: {
    name: { type: "positional", description: "Repo name", required: false },
    all: { type: "boolean", description: "Reset all repos", default: false },
  },
  async run({ args }) {
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
      log.error("Specify a repo name or --all");
      process.exit(1);
    }

    for (const [name, state] of targets) {
      log.info(`Resetting ${name}...`);
      for (const [pkgName, link] of Object.entries(state.packages)) {
        if (link.original) {
          await updatePackageJsonVersion(state.path, pkgName, link.original);
          log.dim(`  ${pkgName} -> ${link.original}`);
        }
      }

      await removeRegistryFromNpmrc(state.path);
      await removeSkipWorktree(state.path);
      state.packages = {};
      state.active = false;
      await saveRepoState(name, state);
      log.success(`Reset ${name}`);
    }
  },
});
