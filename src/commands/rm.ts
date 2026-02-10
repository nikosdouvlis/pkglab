import { defineCommand } from "citty";
import { join } from "node:path";
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

async function removeDependency(
  repoPath: string,
  pkgName: string,
): Promise<void> {
  const pkgJsonPath = join(repoPath, "package.json");
  const pkgJson = await Bun.file(pkgJsonPath).json();
  for (const field of ["dependencies", "devDependencies"]) {
    if (pkgJson[field]?.[pkgName]) {
      delete pkgJson[field][pkgName];
    }
  }
  await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
}

export default defineCommand({
  meta: {
    name: "rm",
    description: "Remove a pkglab package, restore original",
  },
  args: {
    name: { type: "positional", description: "Package name", required: true },
  },
  async run({ args }) {
    const repoPath = await canonicalRepoPath(process.cwd());
    const pkgName = args.name as string;

    const repo = await findRepoByPath(repoPath);
    if (!repo || !repo.state.packages[pkgName]) {
      log.warn(`${pkgName} is not linked via pkglab in this repo`);
      return;
    }

    const original = repo.state.packages[pkgName].original;

    if (original) {
      await updatePackageJsonVersion(repoPath, pkgName, original);
      log.info(`Restored ${pkgName} to ${original}`);
    } else {
      // No original version — remove the dependency entirely
      await removeDependency(repoPath, pkgName);
      log.info(`Removed ${pkgName} (was added by pkglab, no original version)`);
    }

    delete repo.state.packages[pkgName];
    await saveRepoState(repo.name, repo.state);

    if (Object.keys(repo.state.packages).length === 0) {
      await removeRegistryFromNpmrc(repoPath);
      await removeSkipWorktree(repoPath);
      log.info("All pkglab packages removed, .npmrc restored");
    }

    log.success(`Removed ${pkgName} from pkglab`);
  },
});
