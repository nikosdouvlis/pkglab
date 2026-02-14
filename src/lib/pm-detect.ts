import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "package-lock.json": "npm",
};

export async function detectPackageManager(
  startDir: string
): Promise<PackageManager> {
  const entries = Object.entries(LOCKFILES);
  let dir = startDir;

  while (true) {
    const results = await Promise.all(
      entries.map(([lockfile]) => Bun.file(join(dir, lockfile)).exists())
    );

    const found: PackageManager[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (results[i]) {
        const pm = entries[i][1];
        if (!found.includes(pm)) found.push(pm);
      }
    }

    if (found.length === 1) return found[0];
    if (found.length > 1) {
      // Multiple lockfiles: prefer pnpm > yarn > bun > npm
      for (const preferred of ["pnpm", "yarn", "bun", "npm"] as const) {
        if (found.includes(preferred)) return preferred;
      }
      return found[0];
    }

    const parent = join(dir, "..");
    if (parent === dir) return "npm";
    dir = parent;
  }
}
