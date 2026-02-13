import { defineCommand } from "citty";
import { join } from "node:path";
import {
  removeRegistryFromNpmrc,
  removeSkipWorktree,
  updatePackageJsonVersion,
  removePackageJsonDependency,
  findCatalogRoot,
  updateCatalogVersion,
} from "../lib/consumer";
import {
  canonicalRepoPath,
  findRepoByPath,
  saveRepoByPath,
} from "../lib/repo-state";
import { detectPackageManager } from "../lib/pm-detect";
import { run } from "../lib/proc";
import { log } from "../lib/log";

async function restorePackage(
  repoPath: string,
  pkgName: string,
  original: string,
  catalogName?: string,
  catalogFormat?: "package-json" | "pnpm-workspace",
  packageJsonDir?: string,
): Promise<void> {
  const targetDir = packageJsonDir ? join(repoPath, packageJsonDir) : repoPath;
  if (catalogName) {
    const catalogResult = await findCatalogRoot(repoPath);
    if (catalogResult && original) {
      await updateCatalogVersion(catalogResult.root, pkgName, original, catalogName, catalogFormat ?? catalogResult.format);
      log.info(`Restored ${pkgName} to ${original} (catalog)`);
    } else if (!catalogResult) {
      log.warn(`Could not find catalog root for ${pkgName}, restoring in package.json`);
      if (original) await updatePackageJsonVersion(targetDir, pkgName, original);
    }
    return;
  }
  if (original) {
    await updatePackageJsonVersion(targetDir, pkgName, original);
    log.info(`Restored ${pkgName} to ${original}`);
  } else {
    await removePackageJsonDependency(targetDir, pkgName);
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
        const link = repo.state.packages[name];
        await restorePackage(repoPath, name, link.original, link.catalogName, link.catalogFormat, link.packageJsonDir);
        delete repo.state.packages[name];
      }
      await saveRepoByPath(repo.state.path, repo.state);
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

    const link = repo.state.packages[pkgName];
    await restorePackage(repoPath, pkgName, link.original, link.catalogName, link.catalogFormat, link.packageJsonDir);
    delete repo.state.packages[pkgName];
    await saveRepoByPath(repo.state.path, repo.state);

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
