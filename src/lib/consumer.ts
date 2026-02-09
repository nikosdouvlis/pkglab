import { join } from "node:path";
import { log } from "./log";
import { NpmrcConflictError } from "./errors";
import { detectPackageManager, installCommand } from "./pm-detect";
import type { PackageManager } from "./pm-detect";

const MARKER_START = "# pkgl-start";
const MARKER_END = "# pkgl-end";

export async function addRegistryToNpmrc(
  repoPath: string,
  port: number
): Promise<{ isFirstTime: boolean }> {
  const npmrcPath = join(repoPath, ".npmrc");
  const file = Bun.file(npmrcPath);
  let content = "";
  let isFirstTime = true;

  if (await file.exists()) {
    content = await file.text();

    if (content.includes(MARKER_START)) {
      isFirstTime = false;
      content = removePkglBlock(content);
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("registry=") &&
        !trimmed.includes("localhost") &&
        !trimmed.includes("127.0.0.1")
      ) {
        throw new NpmrcConflictError(
          `Existing registry in .npmrc: ${trimmed}\npkgl cannot override this.`
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
  content = removePkglBlock(content);
  await Bun.write(npmrcPath, content);
}

function removePkglBlock(content: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return content;

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + MARKER_END.length);
  return (before + after).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export async function applySkipWorktree(repoPath: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "update-index", "--skip-worktree", ".npmrc"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;
}

export async function removeSkipWorktree(repoPath: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "update-index", "--no-skip-worktree", ".npmrc"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;
}

export async function isSkipWorktreeSet(repoPath: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "ls-files", "-v", ".npmrc"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
  );
  const output = await new Response(proc.stdout).text();
  return output.startsWith("S ");
}

export async function scopedInstall(
  repoPath: string,
  pkgName: string,
  version: string,
  pm?: PackageManager
): Promise<void> {
  const detectedPm = pm || (await detectPackageManager(repoPath));
  const cmd = installCommand(detectedPm, pkgName, version);

  log.dim(`  ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Install failed: ${stderr}`);
  }
}

export async function updatePackageJsonVersion(
  repoPath: string,
  pkgName: string,
  version: string
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
