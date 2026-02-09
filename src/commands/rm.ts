import { defineCommand } from "citty";
import {
  removeRegistryFromNpmrc,
  removeSkipWorktree,
  updatePackageJsonVersion,
} from "../lib/consumer";
import {
  canonicalRepoPath,
  findRepoByPath,
  saveRepoState,
} from "../lib/repo-state";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "rm", description: "Remove a pkgl package, restore original" },
  args: {
    name: { type: "positional", description: "Package name", required: true },
  },
  async run({ args }) {
    const repoPath = await canonicalRepoPath(process.cwd());
    const pkgName = args.name as string;

    const repo = await findRepoByPath(repoPath);
    if (!repo || !repo.state.packages[pkgName]) {
      log.warn(`${pkgName} is not linked via pkgl in this repo`);
      return;
    }

    const original = repo.state.packages[pkgName].original;

    if (original) {
      await updatePackageJsonVersion(repoPath, pkgName, original);
      log.info(`Restored ${pkgName} to ${original}`);
    }

    delete repo.state.packages[pkgName];
    await saveRepoState(repo.name, repo.state);

    if (Object.keys(repo.state.packages).length === 0) {
      await removeRegistryFromNpmrc(repoPath);
      await removeSkipWorktree(repoPath);
      log.info("All pkgl packages removed, .npmrc restored");
    }

    log.success(`Removed ${pkgName} from pkgl`);
  },
});
