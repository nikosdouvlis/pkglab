import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { paths } from "../lib/paths";
import { loadAllRepos } from "../lib/repo-state";
import { isSkipWorktreeSet, applySkipWorktree } from "../lib/consumer";
import { log } from "../lib/log";
import pc from "picocolors";
import { stat } from "node:fs/promises";

export default defineCommand({
  meta: { name: "doctor", description: "Health check for pkglab environment" },
  async run() {
    let issues = 0;

    // Check Bun
    const bunVersion = Bun.version;
    log.line(`  ${pc.green("✓")} Bun ${bunVersion}`);

    // Check pkglab dirs
    for (const dir of [paths.home, paths.reposDir, paths.verdaccioDir]) {
      try {
        await stat(dir);
        log.line(`  ${pc.green("✓")} ${dir}`);
      } catch {
        log.line(`  ${pc.red("✗")} ${dir} missing`);
        issues++;
      }
    }

    // Check daemon
    const status = await getDaemonStatus();
    if (status?.running) {
      log.line(`  ${pc.green("✓")} Verdaccio running (PID ${status.pid})`);

      // Ping registry
      const config = await loadConfig();
      try {
        const resp = await fetch(`http://127.0.0.1:${config.port}/-/ping`);
        if (resp.ok) {
          log.line(
            `  ${pc.green("✓")} Registry responding on port ${config.port}`,
          );
        } else {
          log.line(
            `  ${pc.red("✗")} Registry not responding (HTTP ${resp.status})`,
          );
          issues++;
        }
      } catch {
        log.line(`  ${pc.red("✗")} Registry not responding`);
        issues++;
      }
    } else {
      log.line(`  ${pc.yellow("!")} Verdaccio not running`);
    }

    // Check skip-worktree on linked repos
    const repos = await loadAllRepos();
    for (const [name, state] of Object.entries(repos)) {
      if (Object.keys(state.packages).length === 0) continue;
      try {
        const hasFlag = await isSkipWorktreeSet(state.path);
        if (hasFlag) {
          log.line(`  ${pc.green("✓")} ${name}: skip-worktree OK`);
        } else {
          log.line(
            `  ${pc.yellow("!")} ${name}: skip-worktree missing, repairing...`,
          );
          await applySkipWorktree(state.path);
          log.line(`  ${pc.green("✓")} ${name}: skip-worktree repaired`);
        }
      } catch {
        log.line(`  ${pc.red("✗")} ${name}: could not check skip-worktree`);
        issues++;
      }
    }

    if (issues === 0) {
      log.success("All checks passed");
    } else {
      log.warn(`${issues} issue${issues !== 1 ? "s" : ""} found`);
    }
  },
});
