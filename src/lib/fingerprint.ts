import { join } from "node:path";
import { run } from "./proc";

export interface PackageFingerprint {
  hash: string;
  fileCount: number;
}

// Fingerprint a package by hashing what npm would publish
export async function fingerprintPackage(packageDir: string): Promise<PackageFingerprint> {
  // Use npm pack to get the exact file list npm would include
  const result = await run(
    ["npm", "pack", "--dry-run", "--json"],
    { cwd: packageDir },
  );
  if (result.exitCode !== 0) {
    throw new Error(`npm pack failed in ${packageDir}: ${result.stderr}`);
  }

  const packInfo = JSON.parse(result.stdout);
  const files: string[] = packInfo[0].files
    .map((f: { path: string }) => f.path)
    .sort();

  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const content = await Bun.file(join(packageDir, file)).arrayBuffer();
    hasher.update(new Uint8Array(content));
    hasher.update("\0");
    hasher.update(file);
    hasher.update("\0");
  }

  return { hash: hasher.digest("hex"), fileCount: files.length };
}

// Fingerprint multiple packages in parallel
export async function fingerprintPackages(
  packages: { name: string; dir: string }[],
): Promise<Map<string, PackageFingerprint>> {
  const results = new Map<string, PackageFingerprint>();
  // Process in parallel with concurrency limit
  const CONCURRENCY = 4;
  for (let i = 0; i < packages.length; i += CONCURRENCY) {
    const batch = packages.slice(i, i + CONCURRENCY);
    const fps = await Promise.all(batch.map((p) => fingerprintPackage(p.dir)));
    for (let j = 0; j < batch.length; j++) {
      results.set(batch[j].name, fps[j]);
    }
  }
  return results;
}
