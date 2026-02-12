import { join, basename } from "node:path";
import { realpath, readdir, rename, unlink } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { paths } from "./paths";
import { log } from "./log";
import type { RepoState } from "../types";

const NEW_FORMAT = /^[0-9a-f]{8}--/;

export async function canonicalRepoPath(dir: string): Promise<string> {
  return realpath(dir);
}

export function repoFileName(canonicalPath: string): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update(canonicalPath)
    .digest("hex")
    .slice(0, 8);
  const encoded = canonicalPath.replace(/^\//, "").replace(/\//g, "-");
  const truncated = encoded.length > 50 ? encoded.slice(-50) : encoded;
  return `${hash}--${truncated}`;
}

export async function getRepoDisplayName(repoPath: string): Promise<string> {
  try {
    const pkgFile = Bun.file(join(repoPath, "package.json"));
    if (await pkgFile.exists()) {
      const pkg = await pkgFile.json();
      if (pkg.name) return pkg.name;
    }
  } catch {}
  return basename(repoPath);
}

export async function loadRepoByPath(
  repoPath: string
): Promise<RepoState | null> {
  const canonical = await canonicalRepoPath(repoPath);
  const filename = repoFileName(canonical);
  const file = Bun.file(join(paths.reposDir, `${filename}.yaml`));
  if (!(await file.exists())) return null;
  const text = await file.text();
  return parse(text) as RepoState;
}

export async function saveRepoByPath(
  repoPath: string,
  state: RepoState
): Promise<void> {
  const canonical = await canonicalRepoPath(repoPath);
  const filename = repoFileName(canonical);
  const filePath = join(paths.reposDir, `${filename}.yaml`);
  await Bun.write(filePath, stringify(state));
}

export async function deleteRepoByPath(repoPath: string): Promise<void> {
  // Try realpath first, fall back to raw path for stale repos whose dirs no longer exist.
  // Stored paths in RepoState are already canonical, so the fallback is safe.
  let canonical: string;
  try {
    canonical = await canonicalRepoPath(repoPath);
  } catch {
    canonical = repoPath;
  }
  const filename = repoFileName(canonical);
  const filePath = join(paths.reposDir, `${filename}.yaml`);
  await unlink(filePath).catch((e: any) => {
    if (e?.code !== "ENOENT") throw e;
  });
}

export async function findRepoByPath(
  repoPath: string
): Promise<{ displayName: string; state: RepoState } | null> {
  const canonical = await canonicalRepoPath(repoPath);
  const filename = repoFileName(canonical);
  const file = Bun.file(join(paths.reposDir, `${filename}.yaml`));
  if (!(await file.exists())) return null;
  const text = await file.text();
  const state = parse(text) as RepoState;
  const displayName = await getRepoDisplayName(state.path);
  return { displayName, state };
}

async function migrateOldFiles(
  yamlFiles: string[]
): Promise<string[]> {
  const migrated: string[] = [];
  const oldFiles = yamlFiles.filter((f) => !NEW_FORMAT.test(f));
  const newFiles = yamlFiles.filter((f) => NEW_FORMAT.test(f));

  for (const oldFile of oldFiles) {
    try {
      const oldPath = join(paths.reposDir, oldFile);
      const text = await Bun.file(oldPath).text();
      const state = parse(text) as RepoState;
      if (!state?.path) {
        log.warn(`Skipping migration for ${oldFile}: no path in state`);
        continue;
      }
      const newName = repoFileName(state.path);
      const newFile = `${newName}.yaml`;
      if (newFile === oldFile) {
        migrated.push(newFile);
        continue;
      }
      const newPath = join(paths.reposDir, newFile);
      if (await Bun.file(newPath).exists()) {
        log.warn(`Migration conflict: ${newFile} already exists, skipping ${oldFile}`);
        continue;
      }
      await rename(oldPath, newPath);
      log.dim(`  Migrated repo: ${oldFile} -> ${newFile}`);
      migrated.push(newFile);
    } catch {
      log.warn(`Failed to migrate repo file: ${oldFile}`);
    }
  }

  return [...newFiles, ...migrated];
}

export async function loadAllRepos(): Promise<
  Array<{ displayName: string; state: RepoState }>
> {
  try {
    const files = await readdir(paths.reposDir);
    let yamlFiles = files.filter((f) => f.endsWith(".yaml"));

    const hasOldFormat = yamlFiles.some((f) => !NEW_FORMAT.test(f));
    if (hasOldFormat) {
      yamlFiles = await migrateOldFiles(yamlFiles);
    }

    const entries = await Promise.all(
      yamlFiles.map(async (file) => {
        try {
          const text = await Bun.file(join(paths.reposDir, file)).text();
          const state = parse(text) as RepoState;
          if (!state) return null;
          const displayName = await getRepoDisplayName(state.path);
          return { displayName, state };
        } catch {
          log.warn(`Failed to load repo state: ${file}`);
          return null;
        }
      })
    );

    return entries.filter(
      (e): e is { displayName: string; state: RepoState } => e !== null
    );
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      log.warn(`Failed to read repos directory: ${e?.message ?? e}`);
    }
  }
  return [];
}

export async function getActiveRepos(): Promise<
  Array<{ displayName: string; state: RepoState }>
> {
  const all = await loadAllRepos();
  return all.filter((entry) => entry.state.active);
}

export async function deactivateAllRepos(): Promise<void> {
  const all = await loadAllRepos();
  for (const { state } of all) {
    if (state.active) {
      state.active = false;
      await saveRepoByPath(state.path, state);
    }
  }
}
