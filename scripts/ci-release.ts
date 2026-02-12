// CI release script: cross-compiles binaries, publishes all packages to npm,
// and creates a git tag.

import { mkdirSync } from "node:fs";

const ROOT = import.meta.dir + "/..";

const rootPkg = await Bun.file(`${ROOT}/package.json`).json();
const version = rootPkg.version;

console.log(`Publishing pkglab@${version}`);

// Write .npmrc for auth
const npmToken = process.env.NPM_TOKEN;
if (!npmToken) {
  console.error("ERROR: NPM_TOKEN environment variable is not set");
  process.exit(1);
}
await Bun.write(`${ROOT}/.npmrc`, `//registry.npmjs.org/:_authToken=\${NPM_TOKEN}\n`);
console.log("Wrote .npmrc for npm auth");

const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

// Cross-compile binaries
console.log("\nBuilding binaries...");
for (const platform of platforms) {
  mkdirSync(`${ROOT}/npm/${platform}/bin`, { recursive: true });
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=bun-${platform}`,
      `--define`,
      `__PKGLAB_VERSION__="${version}"`,
      `--outfile`,
      `${ROOT}/npm/${platform}/bin/pkglab`,
      `${ROOT}/src/index.ts`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`ERROR: Failed to build pkglab-${platform}`);
    process.exit(1);
  }
  console.log(`  Built pkglab-${platform}`);
}

// Publish platform packages in parallel
console.log("\nPublishing platform packages...");
const platformResults = await Promise.all(
  platforms.map(async (platform) => {
    console.log(`  Publishing pkglab-${platform}@${version}...`);
    const proc = Bun.spawn(["npm", "publish", `${ROOT}/npm/${platform}/`, "--access", "public"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    return { platform, exitCode };
  }),
);

const failures = platformResults.filter((r) => r.exitCode !== 0);
if (failures.length > 0) {
  console.error(`\nERROR: ${failures.length} platform package(s) failed to publish:`);
  for (const f of failures) {
    console.error(`  - pkglab-${f.platform}`);
  }
  process.exit(1);
}

// Publish main package last (depends on platform packages being available)
console.log(`\nPublishing pkglab@${version}...`);
const mainProc = Bun.spawn(["npm", "publish", `${ROOT}/npm/pkglab/`, "--access", "public"], {
  stdout: "inherit",
  stderr: "inherit",
});
const mainExitCode = await mainProc.exited;
if (mainExitCode !== 0) {
  console.error("ERROR: Failed to publish main pkglab package");
  process.exit(1);
}

// Create git tag
console.log(`\nCreating git tag v${version}...`);
const tagProc = Bun.spawn(["git", "tag", `v${version}`], {
  stdout: "inherit",
  stderr: "inherit",
});
const tagExitCode = await tagProc.exited;
if (tagExitCode !== 0) {
  console.error("ERROR: Failed to create git tag");
  process.exit(1);
}

console.log(`\nSuccessfully published all packages at version ${version}`);
