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
import { detectPackageManager } from "../lib/pm-detect";
import { run } from "../lib/proc";
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

async function restorePackage(
  repoPath: string,
  pkgName: string,
  original: string,
): Promise<void> {
  if (original) {
    await updatePackageJsonVersion(repoPath, pkgName, original);
    log.info(`Restored ${pkgName} to ${original}`);
  } else {
    await removeDependency(repoPath, pkgName);
    log.info(`Removed ${pkgName} (was added by pkglab, no original version)`);
  }
}

export default defineCommand({
  meta: {
    name: "restore",
    description: "Restore pkglab packages to their original versions",
  },
  args: {
    name: { type: "positional", description: "Package name", required: false },
    all: { type: "boolean", description: "Restore all pkglab packages", default: false },
  },
  async run({ args }) {
    const repoPath = await canonicalRepoPath(process.cwd());
    const repo = await findRepoByPath(repoPath);

    if (!repo || Object.keys(repo.state.packages).length === 0) {
      log.warn("No pkglab packages in this repo");
      return;
    }

    if (args.all) {
      const names = Object.keys(repo.state.packages);
      for (const name of names) {
        await restorePackage(repoPath, name, repo.state.packages[name].original);
        delete repo.state.packages[name];
      }
      await saveRepoState(repo.name, repo.state);
      await removeRegistryFromNpmrc(repoPath);
      await removeSkipWorktree(repoPath);

      const pm = await detectPackageManager(repoPath);
      log.dim(`  ${pm} install`);
      const result = await run([pm, "install"], { cwd: repoPath });
      if (result.exitCode !== 0) {
        log.warn(`Install failed, run '${pm} install' manually`);
      }

      log.success(`Restored ${names.length} packages, .npmrc cleaned up`);
      return;
    }

    const pkgName = args.name as string;
    if (!pkgName) {
      log.error("Specify a package name or use --all");
      process.exit(1);
    }

    if (!repo.state.packages[pkgName]) {
      log.warn(`${pkgName} is not linked via pkglab in this repo`);
      return;
    }

    await restorePackage(repoPath, pkgName, repo.state.packages[pkgName].original);
    delete repo.state.packages[pkgName];
    await saveRepoState(repo.name, repo.state);

    if (Object.keys(repo.state.packages).length === 0) {
      await removeRegistryFromNpmrc(repoPath);
      await removeSkipWorktree(repoPath);
      log.info("All pkglab packages removed, .npmrc restored");
    }

    const pm = await detectPackageManager(repoPath);
    log.dim(`  ${pm} install`);
    const result = await run([pm, "install"], { cwd: repoPath });
    if (result.exitCode !== 0) {
      log.warn(`Install failed, run '${pm} install' manually`);
    }

    log.success(`Restored ${pkgName}`);
  },
});
