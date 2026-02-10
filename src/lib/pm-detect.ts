import { join } from "node:path";
import type { WorkspaceTool } from "./workspace";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "package-lock.json": "npm",
};

export async function detectPackageManager(
  repoPath: string
): Promise<PackageManager> {
  const entries = Object.entries(LOCKFILES);
  const results = await Promise.all(
    entries.map(([lockfile]) => Bun.file(join(repoPath, lockfile)).exists())
  );

  const found: PackageManager[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (results[i]) {
      const pm = entries[i][1];
      if (!found.includes(pm)) found.push(pm);
    }
  }

  if (found.length === 0) return "npm";
  if (found.length === 1) return found[0];

  // Multiple lockfiles — prefer the one that matches a known priority
  // (pnpm > yarn > bun > npm) rather than erroring
  for (const preferred of ["pnpm", "yarn", "bun", "npm"] as const) {
    if (found.includes(preferred)) return preferred;
  }
  return found[0];
}

export function packageManagerFromTool(tool: WorkspaceTool): PackageManager {
  switch (tool) {
    case "pnpm": return "pnpm";
    case "yarn": return "yarn";
    case "bolt": return "yarn";
    case "root": return "npm";
    case "lerna": return "npm";
    case "rush": return "npm";
    default: return "npm";
  }
}

export function installCommand(
  pm: PackageManager,
  pkg: string,
  version: string
): string[] {
  const spec = `${pkg}@${version}`;
  switch (pm) {
    case "npm": return ["npm", "install", spec];
    case "pnpm": return ["pnpm", "add", spec];
    case "yarn": return ["yarn", "add", `${pkg}@${version}`];
    case "bun": return ["bun", "add", spec];
  }
}
