import { defineCommand } from "citty";
import { log } from "../lib/log";
import { isPkglVersion } from "../lib/version";
import pc from "picocolors";
import { join } from "node:path";

export default defineCommand({
  meta: { name: "check", description: "Pre-commit safety check for pkgl artifacts" },
  async run() {
    const cwd = process.cwd();
    let issues = 0;

    // Check package.json for pkgl versions
    const pkgJsonPath = join(cwd, "package.json");
    const pkgFile = Bun.file(pkgJsonPath);
    if (await pkgFile.exists()) {
      const pkgJson = await pkgFile.json();
      for (const field of ["dependencies", "devDependencies"]) {
        if (!pkgJson[field]) continue;
        for (const [name, version] of Object.entries(pkgJson[field])) {
          if (typeof version === "string" && isPkglVersion(version)) {
            log.line(`  ${pc.red("✗")} ${field}.${name}: ${version}`);
            issues++;
          }
        }
      }
    }

    // Check .npmrc for pkgl markers
    const npmrcPath = join(cwd, ".npmrc");
    const npmrcFile = Bun.file(npmrcPath);
    if (await npmrcFile.exists()) {
      const content = await npmrcFile.text();
      if (content.includes("# pkgl-start")) {
        log.line(`  ${pc.red("✗")} .npmrc contains pkgl registry markers`);
        issues++;
      }
    }

    // Check git staged files
    try {
      const proc = Bun.spawn(
        ["git", "diff", "--cached", "--name-only"],
        { cwd, stdout: "pipe", stderr: "pipe" }
      );
      const output = await new Response(proc.stdout).text();
      const staged = output.trim().split("\n").filter(Boolean);

      if (staged.includes(".npmrc")) {
        log.line(`  ${pc.red("✗")} .npmrc is staged for commit`);
        issues++;
      }

      // Check staged package.json for pkgl versions
      if (staged.includes("package.json")) {
        const showProc = Bun.spawn(
          ["git", "show", ":package.json"],
          { cwd, stdout: "pipe", stderr: "pipe" }
        );
        const stagedContent = await new Response(showProc.stdout).text();
        if (stagedContent.includes("0.0.0-pkgl.")) {
          log.line(`  ${pc.red("✗")} Staged package.json contains pkgl versions`);
          issues++;
        }
      }
    } catch {
      // Not a git repo, skip git checks
    }

    if (issues === 0) {
      log.success("No pkgl artifacts found");
    } else {
      log.error(`Found ${issues} pkgl artifact${issues !== 1 ? "s" : ""} that should not be committed`);
      process.exit(1);
    }
  },
});
