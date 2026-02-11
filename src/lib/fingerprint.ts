import { join } from "node:path";
import { run } from "./proc";

export interface PackageFingerprint {
  hash: string;
  fileCount: number;
}

// Always included in npm publishes regardless of `files` field
const ALWAYS_INCLUDE_GLOBS = [
  "package.json",
  "README{,.*}",
  "LICENSE{,.*}",
  "LICENCE{,.*}",
  "CHANGELOG{,.*}",
];

// Collect publishable file paths for a package using pure filesystem ops.
// Replicates npm's file inclusion logic: `files` field patterns, always-included
// files, and entry points from main/module/types/bin/exports. Falls back to
// `npm pack --dry-run --json` when the package uses bundledDependencies (rare).
async function collectPublishFiles(
  packageDir: string,
  pkgJson: Record<string, any>,
): Promise<string[]> {
  const fileSet = new Set<string>();

  if (pkgJson.files && Array.isArray(pkgJson.files)) {
    // If any entry uses negation patterns, fall back to a full walk since
    // Bun.Glob doesn't model npm's negation semantics.
    const hasNegation = pkgJson.files.some((p: string) => p.startsWith("!"));

    if (hasNegation) {
      const glob = new Bun.Glob("**");
      for await (const match of glob.scan({ cwd: packageDir, onlyFiles: true })) {
        if (match.startsWith("node_modules/") || match.startsWith(".git/") || match.startsWith(".turbo/")) continue;
        fileSet.add(match);
      }
    } else {
      for (const pattern of pkgJson.files as string[]) {
        // Glob as a file match
        const fileGlob = new Bun.Glob(pattern.endsWith("/") ? pattern + "**" : pattern);
        for await (const match of fileGlob.scan({ cwd: packageDir, onlyFiles: true })) {
          fileSet.add(match);
        }
        // Also treat bare names as possible directories
        if (!pattern.includes("*") && !pattern.endsWith("/")) {
          const dirGlob = new Bun.Glob(pattern + "/**");
          for await (const match of dirGlob.scan({ cwd: packageDir, onlyFiles: true })) {
            fileSet.add(match);
          }
        }
      }
    }
  } else {
    // No files field: include everything minus common exclusions
    const glob = new Bun.Glob("**");
    for await (const match of glob.scan({ cwd: packageDir, onlyFiles: true })) {
      if (match.startsWith("node_modules/") || match.startsWith(".git/") || match.startsWith(".turbo/")) continue;
      fileSet.add(match);
    }
  }

  // Always-included files
  for (const pattern of ALWAYS_INCLUDE_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const match of glob.scan({ cwd: packageDir, onlyFiles: true })) {
      fileSet.add(match);
    }
  }

  // Entry points from package.json fields
  for (const field of ["main", "module", "types", "typings"] as const) {
    const val = pkgJson[field];
    if (typeof val === "string") fileSet.add(val.replace(/^\.\//, ""));
  }

  // bin field (string or object)
  if (typeof pkgJson.bin === "string") {
    fileSet.add(pkgJson.bin.replace(/^\.\//, ""));
  } else if (pkgJson.bin && typeof pkgJson.bin === "object") {
    for (const v of Object.values(pkgJson.bin)) {
      if (typeof v === "string") fileSet.add(v.replace(/^\.\//, ""));
    }
  }

  // exports field: recursively extract string leaf values starting with "./"
  if (pkgJson.exports) {
    collectExportPaths(pkgJson.exports, fileSet);
  }

  return [...fileSet].sort();
}

// Walk the exports map recursively, collecting relative file paths
function collectExportPaths(node: unknown, out: Set<string>): void {
  if (typeof node === "string") {
    if (node.startsWith("./")) out.add(node.slice(2));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectExportPaths(item, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const val of Object.values(node)) collectExportPaths(val, out);
  }
}

// Fingerprint a package by hashing the files npm would publish.
// Uses pure filesystem globbing instead of spawning npm processes.
// Falls back to `npm pack --dry-run --json` for packages with bundledDependencies.
export async function fingerprintPackage(packageDir: string): Promise<PackageFingerprint> {
  const pkgJson = await Bun.file(join(packageDir, "package.json")).json();

  // bundledDependencies pulls from node_modules which we can't replicate cheaply
  if (pkgJson.bundledDependencies?.length || pkgJson.bundleDependencies?.length) {
    return fingerprintPackageStrict(packageDir);
  }

  const files = await collectPublishFiles(packageDir, pkgJson);

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("pkglab-fp-v2\0");

  // Include ignore files in the hash so rule changes invalidate the fingerprint
  for (const ignoreFile of [".npmignore", ".gitignore"]) {
    const f = Bun.file(join(packageDir, ignoreFile));
    if (await f.exists()) {
      hasher.update(ignoreFile);
      hasher.update("\0");
      hasher.update(new Uint8Array(await f.arrayBuffer()));
      hasher.update("\0");
    }
  }

  for (const file of files) {
    const f = Bun.file(join(packageDir, file));
    if (!(await f.exists())) continue;
    hasher.update(new Uint8Array(await f.arrayBuffer()));
    hasher.update("\0");
    hasher.update(file);
    hasher.update("\0");
  }

  return { hash: hasher.digest("hex"), fileCount: files.length };
}

// Strict fallback: uses npm pack --dry-run --json for exact file list.
// Only used for packages with bundledDependencies.
async function fingerprintPackageStrict(packageDir: string): Promise<PackageFingerprint> {
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
  hasher.update("pkglab-fp-v2\0");
  for (const file of files) {
    const content = await Bun.file(join(packageDir, file)).arrayBuffer();
    hasher.update(new Uint8Array(content));
    hasher.update("\0");
    hasher.update(file);
    hasher.update("\0");
  }

  return { hash: hasher.digest("hex"), fileCount: files.length };
}

// Fingerprint multiple packages in parallel.
// Safe to run unbounded since there are no subprocess spawns, just filesystem reads.
export async function fingerprintPackages(
  packages: { name: string; dir: string }[],
): Promise<Map<string, PackageFingerprint>> {
  const results = new Map<string, PackageFingerprint>();
  const fps = await Promise.all(packages.map((p) => fingerprintPackage(p.dir)));
  for (let i = 0; i < packages.length; i++) {
    results.set(packages[i].name, fps[i]);
  }
  return results;
}
