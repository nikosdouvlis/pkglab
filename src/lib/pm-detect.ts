import { join } from "node:path";
import { PackageManagerAmbiguousError } from "./errors";

export type PackageManager = "npm" | "pnpm" | "bun";

const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "package-lock.json": "npm",
};

export async function detectPackageManager(
  repoPath: string
): Promise<PackageManager> {
  const found: PackageManager[] = [];

  for (const [lockfile, pm] of Object.entries(LOCKFILES)) {
    const file = Bun.file(join(repoPath, lockfile));
    if (await file.exists()) {
      if (!found.includes(pm)) found.push(pm);
    }
  }

  if (found.length === 0) return "npm";
  if (found.length > 1) {
    throw new PackageManagerAmbiguousError(
      `Multiple PMs detected: ${found.join(", ")}. Remove extra lockfiles.`
    );
  }
  return found[0];
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
    case "bun": return ["bun", "add", spec];
  }
}
