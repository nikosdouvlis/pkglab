import { join } from "node:path";
import { log } from "./log";
import { NpmrcConflictError } from "./errors";
import { detectPackageManager, installCommand, batchInstallCommand } from "./pm-detect";
import type { PackageManager } from "./pm-detect";
import { run } from "./proc";
import { getActiveRepos, saveRepoState } from "./repo-state";
import { createMultiSpinner } from "./spinner";
import type { SpinnerLine } from "./spinner";
import type { PublishPlan } from "../types";

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
): Promise<{ previousVersion: string }> {
  const pkgJsonPath = join(repoPath, "package.json");
  const pkgJson = await Bun.file(pkgJsonPath).json();

  let previousVersion = "";
  for (const field of ["dependencies", "devDependencies"]) {
    if (pkgJson[field]?.[pkgName]) {
      previousVersion = pkgJson[field][pkgName];
      pkgJson[field][pkgName] = version;
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
        spinnerLines.push(entry.name);
      }
    }

    const repoSpinner = createMultiSpinner(spinnerLines);
    repoSpinner.start();

    try {
      await Promise.all(
        work.map(async (repo, r) => {
          const repoTasks = tasks.filter((t) => t.repoIdx === r);

          // Update all package.json versions, storing previous for rollback
          const prevVersions: { name: string; version: string }[] = [];
          for (const entry of repo.packages) {
            const { previousVersion } = await updatePackageJsonVersion(repo.state.path, entry.name, entry.version);
            prevVersions.push({ name: entry.name, version: previousVersion });
          }

          // Run one batch install for all packages
          const cmd = batchInstallCommand(repo.pm, repo.packages.map((e) => ({ name: e.name, version: e.version })));
          const result = await run(cmd, { cwd: repo.state.path });
          if (result.exitCode !== 0) {
            // Revert package.json so it stays consistent with node_modules
            for (const prev of prevVersions) {
              await updatePackageJsonVersion(repo.state.path, prev.name, prev.version);
            }
            const output = (result.stderr || result.stdout).trim();
            throw new Error(`Install failed (${repo.pm}): ${output}`);
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
        // Update all package.json versions, storing previous for rollback
        const prevVersions: { name: string; version: string }[] = [];
        for (const entry of repo.packages) {
          const { previousVersion } = await updatePackageJsonVersion(repo.state.path, entry.name, entry.version);
          prevVersions.push({ name: entry.name, version: previousVersion });
        }

        // Run one batch install for all packages
        const cmd = batchInstallCommand(repo.pm, repo.packages.map((e) => ({ name: e.name, version: e.version })));
        log.dim(`  ${cmd.join(" ")}`);
        const result = await run(cmd, { cwd: repo.state.path });
        if (result.exitCode !== 0) {
          for (const prev of prevVersions) {
            await updatePackageJsonVersion(repo.state.path, prev.name, prev.version);
          }
          const output = (result.stderr || result.stdout).trim();
          throw new Error(`Install failed (${repo.pm}): ${output}`);
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
