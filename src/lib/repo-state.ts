import { join, basename } from "node:path";
import { realpath, readdir } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { paths } from "./paths";
import type { RepoState } from "../types";

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
  let candidate = name;
  let suffix = 2;
  while (all[candidate]) {
    candidate = `${name}~${suffix}`;
    suffix++;
  }
  return candidate;
}

export async function loadRepoState(name: string): Promise<RepoState | null> {
  const file = Bun.file(join(paths.reposDir, `${name}.yaml`));
  if (!(await file.exists())) return null;
  const text = await file.text();
  return parse(text) as RepoState;
}

export async function saveRepoState(
  name: string,
  state: RepoState
): Promise<void> {
  const filePath = join(paths.reposDir, `${name}.yaml`);
  await Bun.write(filePath, stringify(state));
}

export async function loadAllRepos(): Promise<Record<string, RepoState>> {
  const result: Record<string, RepoState> = {};
  try {
    const files = await readdir(paths.reposDir);
    for (const file of files) {
      if (!file.endsWith(".yaml")) continue;
      const name = file.replace(".yaml", "");
      const state = await loadRepoState(name);
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
