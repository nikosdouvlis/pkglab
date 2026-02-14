import { defineCommand } from "citty";
import { log } from "../lib/log";
import { ispkglabVersion } from "../lib/version";
import { c } from "../lib/color";
import { run } from "../lib/proc";
import { discoverWorkspace } from "../lib/workspace";
import { join, relative } from "node:path";

export default defineCommand({
  meta: {
    name: "check",
    description: "Pre-commit safety check for pkglab artifacts",
  },
  async run() {
    const cwd = process.cwd();
    let issues = 0;

    // Scan root package.json
    issues += await scanPackageJson(cwd, "");

    // Discover workspace sub-packages and scan each
    try {
      const workspace = await discoverWorkspace(cwd);
      for (const pkg of workspace.packages) {
        if (pkg.dir === workspace.root) continue;
        const rel = relative(cwd, pkg.dir);
        issues += await scanPackageJson(pkg.dir, rel);
      }
    } catch {
      // Not a workspace or discovery failed, root-only scan is fine
    }

    // Check .npmrc for pkglab markers
    const npmrcPath = join(cwd, ".npmrc");
    const npmrcFile = Bun.file(npmrcPath);
    if (await npmrcFile.exists()) {
      const content = await npmrcFile.text();
      if (content.includes("# pkglab-start")) {
        log.line(`  ${c.red("✗")} .npmrc contains pkglab registry markers`);
        issues++;
      }
    }

    // Check git staged files
    try {
      const result = await run(["git", "diff", "--cached", "--name-only"], { cwd });
      const staged = result.stdout.trim().split("\n").filter(Boolean);

      if (staged.includes(".npmrc")) {
        log.line(`  ${c.red("✗")} .npmrc is staged for commit`);
        issues++;
      }

      // Check all staged package.json files (root and sub-packages)
      const stagedPkgJsons = staged.filter(
        (f) => f === "package.json" || f.endsWith("/package.json"),
      );
      for (const pkgJsonFile of stagedPkgJsons) {
        const showResult = await run(["git", "show", `:${pkgJsonFile}`], { cwd });
        if (
          showResult.stdout.includes("0.0.0-pkglab.") ||
          showResult.stdout.includes("0.0.0-pkglab-")
        ) {
          log.line(
            `  ${c.red("✗")} Staged ${pkgJsonFile} contains pkglab versions`,
          );
          issues++;
        }
      }
    } catch {
      // Not a git repo, skip git checks
    }

    if (issues === 0) {
      log.success("No pkglab artifacts found");
    } else {
      log.error(
        `Found ${issues} pkglab artifact${issues !== 1 ? "s" : ""} that should not be committed`,
      );
      process.exit(1);
    }
  },
});

async function scanPackageJson(dir: string, label: string): Promise<number> {
  const pkgJsonPath = join(dir, "package.json");
  const pkgFile = Bun.file(pkgJsonPath);
  if (!(await pkgFile.exists())) return 0;

  let issues = 0;
  const prefix = label ? `${label}/` : "";
  const pkgJson = await pkgFile.json();

  for (const field of ["dependencies", "devDependencies"]) {
    if (!pkgJson[field]) continue;
    for (const [name, version] of Object.entries(pkgJson[field])) {
      if (typeof version === "string" && ispkglabVersion(version)) {
        log.line(`  ${c.red("✗")} ${prefix}${field}.${name}: ${version}`);
        issues++;
      }
    }
  }

  // Check catalog fields for pkglab versions
  if (pkgJson.catalog) {
    for (const [name, version] of Object.entries(pkgJson.catalog)) {
      if (typeof version === "string" && ispkglabVersion(version)) {
        log.line(`  ${c.red("✗")} ${prefix}catalog.${name}: ${version}`);
        issues++;
      }
    }
  }
  if (pkgJson.catalogs) {
    for (const [catName, entries] of Object.entries(pkgJson.catalogs)) {
      if (!entries || typeof entries !== "object") continue;
      for (const [name, version] of Object.entries(entries as Record<string, string>)) {
        if (typeof version === "string" && ispkglabVersion(version)) {
          log.line(`  ${c.red("✗")} ${prefix}catalogs.${catName}.${name}: ${version}`);
          issues++;
        }
      }
    }
  }

  return issues;
}
