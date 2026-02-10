import { defineCommand } from "citty";
import { log } from "../lib/log";
import { ispkglabVersion } from "../lib/version";
import { c } from "../lib/color";
import { join } from "node:path";

export default defineCommand({
  meta: {
    name: "check",
    description: "Pre-commit safety check for pkglab artifacts",
  },
  async run() {
    const cwd = process.cwd();
    let issues = 0;

    // Check package.json for pkglab versions
    const pkgJsonPath = join(cwd, "package.json");
    const pkgFile = Bun.file(pkgJsonPath);
    if (await pkgFile.exists()) {
      const pkgJson = await pkgFile.json();
      for (const field of ["dependencies", "devDependencies"]) {
        if (!pkgJson[field]) continue;
        for (const [name, version] of Object.entries(pkgJson[field])) {
          if (typeof version === "string" && ispkglabVersion(version)) {
            log.line(`  ${c.red("✗")} ${field}.${name}: ${version}`);
            issues++;
          }
        }
      }
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
      const proc = Bun.spawn(["git", "diff", "--cached", "--name-only"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      const staged = output.trim().split("\n").filter(Boolean);

      if (staged.includes(".npmrc")) {
        log.line(`  ${c.red("✗")} .npmrc is staged for commit`);
        issues++;
      }

      // Check staged package.json for pkglab versions
      if (staged.includes("package.json")) {
        const showProc = Bun.spawn(["git", "show", ":package.json"], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const stagedContent = await new Response(showProc.stdout).text();
        if (
          stagedContent.includes("0.0.0-pkglab.") ||
          stagedContent.includes("0.0.0-pkglab-")
        ) {
          log.line(
            `  ${c.red("✗")} Staged package.json contains pkglab versions`,
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
