import { join, basename } from "node:path";
import { realpath, readdir } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { paths } from "./paths";
import { log } from "./log";
import type { RepoState } from "../types";

const VALID_REPO_NAME = /^[a-zA-Z0-9._~-]+$/;

export function validateRepoName(name: string): void {
  if (!VALID_REPO_NAME.test(name) || name.includes("..")) {
    throw new Error(`Invalid repo name: ${name}. Only alphanumeric, dots, underscores, tildes, and hyphens allowed.`);
  }
}

export async function canonicalRepoPath(dir: string): Promise<string> {
  return realpath(dir);
}

async function deriveRepoName(repoPath: string): Promise<string> {
  const pkgFile = Bun.file(join(repoPath, "package.json"));
  if (await pkgFile.exists()) {
    try {
      const pkg = await pkgFile.json();
      if (pkg.name) return pkg.name.replace("/", "-").replace("@", "");
    } catch {}
  }
  return basename(repoPath);
}

export async function repoFileName(repoPath: string): Promise<string> {
  const all = await loadAllRepos();

  // Check if this path is already registered
  for (const [filename, state] of Object.entries(all)) {
    if (state.path === repoPath) return filename;
  }

  const name = await deriveRepoName(repoPath);
  // Sanitize derived name
  const safeName = name.replace(/[^a-zA-Z0-9._~-]/g, "-");
  let candidate = safeName;
  let suffix = 2;
  while (all[candidate]) {
    candidate = `${safeName}~${suffix}`;
    suffix++;
  }
  return candidate;
}

export async function loadRepoState(name: string): Promise<RepoState | null> {
  validateRepoName(name);
  const file = Bun.file(join(paths.reposDir, `${name}.yaml`));
  if (!(await file.exists())) return null;
  const text = await file.text();
  return parse(text) as RepoState;
}

export async function saveRepoState(
  name: string,
  state: RepoState
): Promise<void> {
  validateRepoName(name);
  const filePath = join(paths.reposDir, `${name}.yaml`);
  await Bun.write(filePath, stringify(state));
}

export async function loadAllRepos(): Promise<Record<string, RepoState>> {
  const result: Record<string, RepoState> = {};
  try {
    const files = await readdir(paths.reposDir);
    const yamlFiles = files.filter((f) => f.endsWith(".yaml"));
    const entries = await Promise.all(
      yamlFiles.map(async (file) => {
        const name = file.replace(".yaml", "");
        try {
          const state = await loadRepoState(name);
          return [name, state] as const;
        } catch {
          log.warn(`Failed to load repo state: ${file}`);
          return [name, null] as const;
        }
      })
    );
    for (const [name, state] of entries) {
      if (state) result[name] = state;
    }
  } catch {}
  return result;
}

export async function findRepoByPath(
  repoPath: string
): Promise<{ name: string; state: RepoState } | null> {
  const canonical = await canonicalRepoPath(repoPath);
  const all = await loadAllRepos();
  for (const [name, state] of Object.entries(all)) {
    if (state.path === canonical) return { name, state };
  }
  return null;
}

export async function getActiveRepos(): Promise<
  Array<{ name: string; state: RepoState }>
> {
  const all = await loadAllRepos();
  return Object.entries(all)
    .filter(([_, state]) => state.active)
    .map(([name, state]) => ({ name, state }));
}

export async function deactivateAllRepos(): Promise<void> {
  const all = await loadAllRepos();
  for (const [name, state] of Object.entries(all)) {
    if (state.active) {
      state.active = false;
      await saveRepoState(name, state);
    }
  }
}
