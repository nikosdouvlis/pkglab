import { join } from "node:path";
import { log } from "./log";
import { NpmrcConflictError } from "./errors";
import { detectPackageManager, installCommand, batchInstallCommand } from "./pm-detect";
import type { PackageManager } from "./pm-detect";
import { run } from "./proc";
import { getActiveRepos, saveRepoState } from "./repo-state";
import { createMultiSpinner } from "./spinner";
import type { SpinnerLine } from "./spinner";
import type { PublishPlan, PublishEntry, RepoState } from "../types";

const MARKER_START = "# pkglab-start";
const MARKER_END = "# pkglab-end";

export async function addRegistryToNpmrc(
  repoPath: string,
  port: number,
): Promise<{ isFirstTime: boolean }> {
  const npmrcPath = join(repoPath, ".npmrc");
  const file = Bun.file(npmrcPath);
  let content = "";
  let isFirstTime = true;

  if (await file.exists()) {
    content = await file.text();

    if (content.includes(MARKER_START)) {
      isFirstTime = false;
      content = removepkglabBlock(content);
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("registry=") &&
        !trimmed.includes("localhost") &&
        !trimmed.includes("127.0.0.1")
      ) {
        throw new NpmrcConflictError(
          `Existing registry in .npmrc: ${trimmed}\npkglab cannot override this.`,
        );
      }
    }
  }

  const block = `${MARKER_START}\nregistry=http://127.0.0.1:${port}\n${MARKER_END}`;
  content = content.trimEnd() + "\n" + block + "\n";
  await Bun.write(npmrcPath, content);

  return { isFirstTime };
}

export async function removeRegistryFromNpmrc(repoPath: string): Promise<void> {
  const npmrcPath = join(repoPath, ".npmrc");
  const file = Bun.file(npmrcPath);
  if (!(await file.exists())) return;

  let content = await file.text();
  content = removepkglabBlock(content);
  await Bun.write(npmrcPath, content);
}

function removepkglabBlock(content: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return content;

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + MARKER_END.length);
  return (before + after).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export async function applySkipWorktree(repoPath: string): Promise<void> {
  // skip-worktree only works on tracked files
  if (!(await isTrackedByGit(repoPath, ".npmrc"))) return;

  const result = await run(["git", "update-index", "--skip-worktree", ".npmrc"], { cwd: repoPath });
  if (result.exitCode !== 0) {
    log.warn(`Failed to set skip-worktree on .npmrc: ${result.stderr.trim()}`);
  }
}

export async function removeSkipWorktree(repoPath: string): Promise<void> {
  if (!(await isTrackedByGit(repoPath, ".npmrc"))) return;

  const result = await run(["git", "update-index", "--no-skip-worktree", ".npmrc"], { cwd: repoPath });
  if (result.exitCode !== 0) {
    log.warn(`Failed to clear skip-worktree on .npmrc: ${result.stderr.trim()}`);
  }
}

async function isTrackedByGit(repoPath: string, file: string): Promise<boolean> {
  const result = await run(["git", "ls-files", file], { cwd: repoPath });
  return result.stdout.trim().length > 0;
}

export async function isSkipWorktreeSet(repoPath: string): Promise<boolean> {
  const result = await run(["git", "ls-files", "-v", ".npmrc"], { cwd: repoPath });
  return result.stdout.startsWith("S ");
}

export async function scopedInstall(
  repoPath: string,
  pkgName: string,
  version: string,
  pm?: PackageManager,
  quiet?: boolean,
): Promise<void> {
  const detectedPm = pm || (await detectPackageManager(repoPath));
  const cmd = installCommand(detectedPm, pkgName, version);

  if (!quiet) log.dim(`  ${cmd.join(" ")}`);
  const result = await run(cmd, { cwd: repoPath });
  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout).trim();
    throw new Error(`Install failed (${detectedPm}): ${output}`);
  }
}

export async function updatePackageJsonVersion(
  repoPath: string,
  pkgName: string,
  version: string,
): Promise<{ previousVersion: string | null }> {
  const pkgJsonPath = join(repoPath, "package.json");
  const pkgJson = await Bun.file(pkgJsonPath).json();

  let previousVersion: string | null = null;
  for (const field of ["dependencies", "devDependencies"]) {
    if (pkgJson[field]?.[pkgName]) {
      previousVersion = pkgJson[field][pkgName];
      pkgJson[field][pkgName] = version;
    }
  }

  await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  return { previousVersion };
}

export async function removePackageJsonDependency(
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

/**
 * Walk up from startDir to find the nearest package.json with a catalog or catalogs field.
 */
export async function findCatalogRoot(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    const file = Bun.file(join(dir, "package.json"));
    if (await file.exists()) {
      const pkgJson = await file.json();
      if (pkgJson.catalog || pkgJson.catalogs) return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Find which catalog (default or named) contains a given package.
 * Returns null if the package isn't in any catalog.
 */
export function findCatalogEntry(
  rootPkgJson: any,
  pkgName: string,
): { catalogName: string; version: string } | null {
  if (rootPkgJson.catalog?.[pkgName] !== undefined) {
    return { catalogName: "default", version: rootPkgJson.catalog[pkgName] };
  }
  if (rootPkgJson.catalogs) {
    for (const [name, entries] of Object.entries(rootPkgJson.catalogs)) {
      if (entries && typeof entries === "object" && (entries as any)[pkgName] !== undefined) {
        return { catalogName: name, version: (entries as any)[pkgName] };
      }
    }
  }
  return null;
}

/**
 * Update a version in the workspace root catalog (or named catalog).
 */
export async function updateCatalogVersion(
  rootDir: string,
  pkgName: string,
  version: string,
  catalogName: string,
): Promise<{ previousVersion: string | null }> {
  const pkgJsonPath = join(rootDir, "package.json");
  const pkgJson = await Bun.file(pkgJsonPath).json();

  let previousVersion: string | null = null;
  if (catalogName === "default") {
    if (pkgJson.catalog?.[pkgName] !== undefined) {
      previousVersion = pkgJson.catalog[pkgName];
      pkgJson.catalog[pkgName] = version;
    }
  } else {
    if (pkgJson.catalogs?.[catalogName]?.[pkgName] !== undefined) {
      previousVersion = pkgJson.catalogs[catalogName][pkgName];
      pkgJson.catalogs[catalogName][pkgName] = version;
    }
  }

  await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  return { previousVersion };
}

export async function ensureNpmrcForActiveRepos(port: number): Promise<void> {
  const activeRepos = await getActiveRepos();
  for (const { name, state } of activeRepos) {
    if (Object.keys(state.packages).length === 0) continue;
    const npmrcFile = Bun.file(join(state.path, ".npmrc"));
    const exists = await npmrcFile.exists();
    const hasBlock = exists && (await npmrcFile.text()).includes(MARKER_START);
    if (!hasBlock) {
      try {
        await addRegistryToNpmrc(state.path, port);
        await applySkipWorktree(state.path);
        log.dim(`  Repaired .npmrc for ${name}`);
      } catch {
        log.warn(`Could not repair .npmrc for ${name}`);
      }
    }
  }
}

interface RepoRollback {
  catalogEntries: { name: string; version: string | null; catalogName: string; rootDir: string }[];
  directEntries: { name: string; version: string | null }[];
}

async function updateRepoVersions(
  state: RepoState,
  packages: PublishEntry[],
): Promise<RepoRollback> {
  const rollback: RepoRollback = { catalogEntries: [], directEntries: [] };

  for (const entry of packages) {
    const link = state.packages[entry.name];
    if (link?.catalogName) {
      const catalogRoot = await findCatalogRoot(state.path);
      if (catalogRoot) {
        const { previousVersion } = await updateCatalogVersion(catalogRoot, entry.name, entry.version, link.catalogName);
        rollback.catalogEntries.push({ name: entry.name, version: previousVersion, catalogName: link.catalogName, rootDir: catalogRoot });
      }
    } else {
      const { previousVersion } = await updatePackageJsonVersion(state.path, entry.name, entry.version);
      rollback.directEntries.push({ name: entry.name, version: previousVersion });
    }
  }

  return rollback;
}

async function rollbackRepoVersions(state: RepoState, rollback: RepoRollback): Promise<void> {
  for (const prev of rollback.catalogEntries) {
    if (prev.version !== null) {
      await updateCatalogVersion(prev.rootDir, prev.name, prev.version, prev.catalogName);
    }
  }
  for (const prev of rollback.directEntries) {
    if (prev.version === "" || prev.version === null) {
      await removePackageJsonDependency(state.path, prev.name);
    } else {
      await updatePackageJsonVersion(state.path, prev.name, prev.version);
    }
  }
}

function repoInstallCommand(
  pm: PackageManager,
  packages: PublishEntry[],
  state: RepoState,
): { cmd: string[]; cwd: string } {
  // If any package is catalog-linked, use plain install (catalog entries already updated)
  const hasCatalog = packages.some((e) => state.packages[e.name]?.catalogName);
  if (hasCatalog) {
    return { cmd: [pm, "install"], cwd: state.path };
  }
  return {
    cmd: batchInstallCommand(pm, packages.map((e) => ({ name: e.name, version: e.version }))),
    cwd: state.path,
  };
}

const BUNFIG_MARKER = "\n# pkglab-manifest-override\n";

/**
 * Temporarily append [install.cache] disableManifest = true to the consumer's
 * bunfig.toml so bun skips its 5-minute metadata cache and sees freshly
 * published versions. Returns a restore function.
 */
async function disableBunManifestCache(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, "bunfig.toml");
  const file = Bun.file(path);
  const original = (await file.exists()) ? await file.text() : null;

  const override = `${BUNFIG_MARKER}[install.cache]\ndisableManifest = true\n`;
  await Bun.write(path, (original ?? "") + override);

  return async () => {
    if (original === null) {
      const { unlink } = await import("node:fs/promises");
      await unlink(path).catch(() => {});
    } else {
      await Bun.write(path, original);
    }
  };
}

export async function updateActiveRepos(
  plan: PublishPlan,
  verbose: boolean,
  tag?: string,
): Promise<void> {
  const activeRepos = await getActiveRepos();
  if (activeRepos.length === 0) return;

  // Build per-repo work items: which packages to update and the install command
  const pubTag = tag ?? null;
  const repoWork = await Promise.all(
    activeRepos.map(async ({ name, state }) => {
      const pm = await detectPackageManager(state.path);
      const packages = plan.packages.filter((e) => {
        const link = state.packages[e.name];
        if (!link) return false;
        // Match by tag: untagged pub updates untagged consumers, tagged pub updates matching tag
        const linkTag = link.tag ?? null;
        return linkTag === pubTag;
      });
      return { name, state, pm, packages };
    }),
  );
  const work = repoWork.filter((r) => r.packages.length > 0);

  if (work.length === 0) return;

  if (!verbose) {
    // Build grouped spinner lines with task index tracking
    const spinnerLines: SpinnerLine[] = [];
    const tasks: { repoIdx: number; spinnerIdx: number }[] = [];

    for (let r = 0; r < work.length; r++) {
      const { name, packages } = work[r];
      spinnerLines.push({ text: `${name}:`, header: true });
      for (const entry of packages) {
        tasks.push({ repoIdx: r, spinnerIdx: spinnerLines.length });
        spinnerLines.push(`updated ${entry.name}`);
      }
    }

    const repoSpinner = createMultiSpinner(spinnerLines);
    repoSpinner.start();

    try {
      await Promise.all(
        work.map(async (repo, r) => {
          const repoTasks = tasks.filter((t) => t.repoIdx === r);
          const rollback = await updateRepoVersions(repo.state, repo.packages);

          const { cmd, cwd } = repoInstallCommand(repo.pm, repo.packages, repo.state);
          const restoreBunfig = repo.pm === "bun"
            ? await disableBunManifestCache(cwd)
            : null;
          try {
            const result = await run(cmd, { cwd });
            if (result.exitCode !== 0) {
              await rollbackRepoVersions(repo.state, rollback);
              const output = (result.stderr || result.stdout).trim();
              throw new Error(`Install failed (${repo.pm}): ${output}`);
            }
          } finally {
            await restoreBunfig?.();
          }

          // Mark all tasks complete and update state
          for (let i = 0; i < repo.packages.length; i++) {
            repo.state.packages[repo.packages[i].name].current = repo.packages[i].version;
            repoSpinner.complete(repoTasks[i].spinnerIdx);
          }
          await saveRepoState(repo.name, repo.state);
        }),
      );
    } finally {
      repoSpinner.stop();
    }
  } else {
    log.info("\nUpdating active repos:");
    await Promise.all(
      work.map(async (repo) => {
        const rollback = await updateRepoVersions(repo.state, repo.packages);

        const { cmd, cwd } = repoInstallCommand(repo.pm, repo.packages, repo.state);
        log.dim(`  ${cmd.join(" ")}`);
        const restoreBunfig = repo.pm === "bun"
          ? await disableBunManifestCache(cwd)
          : null;
        try {
          const result = await run(cmd, { cwd });
          if (result.exitCode !== 0) {
            await rollbackRepoVersions(repo.state, rollback);
            const output = (result.stderr || result.stdout).trim();
            throw new Error(`Install failed (${repo.pm}): ${output}`);
          }
        } finally {
          await restoreBunfig?.();
        }

        for (const entry of repo.packages) {
          repo.state.packages[entry.name].current = entry.version;
        }
        await saveRepoState(repo.name, repo.state);
        log.success(`  ${repo.name}: updated ${repo.packages.map((e) => e.name).join(", ")}`);
      }),
    );
  }
}
