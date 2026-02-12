import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { paths } from "../lib/paths";
import { loadAllRepos } from "../lib/repo-state";
import { isSkipWorktreeSet, applySkipWorktree, addRegistryToNpmrc } from "../lib/consumer";
import { log } from "../lib/log";
import { c } from "../lib/color";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const MARKER_START = "# pkglab-start";

export default defineCommand({
  meta: { name: "doctor", description: "Health check for pkglab environment" },
  async run() {
    let issues = 0;

    // Check Bun
    const bunVersion = Bun.version;
    log.line(`  ${c.green("✓")} Bun ${bunVersion}`);

    // Check pkglab dirs
    for (const dir of [paths.home, paths.reposDir, paths.verdaccioDir]) {
      try {
        await stat(dir);
        log.line(`  ${c.green("✓")} ${dir}`);
      } catch {
        log.line(`  ${c.red("✗")} ${dir} missing`);
        issues++;
      }
    }

    // Check daemon
    const config = await loadConfig();
    const status = await getDaemonStatus();
    if (status?.running) {
      log.line(`  ${c.green("✓")} Verdaccio running (PID ${status.pid})`);

      // Ping registry
      try {
        const resp = await fetch(`http://127.0.0.1:${config.port}/-/ping`);
        if (resp.ok) {
          log.line(
            `  ${c.green("✓")} Registry responding on port ${config.port}`,
          );
        } else {
          log.line(
            `  ${c.red("✗")} Registry not responding (HTTP ${resp.status})`,
          );
          issues++;
        }
      } catch {
        log.line(`  ${c.red("✗")} Registry not responding`);
        issues++;
      }
    } else {
      log.line(`  ${c.yellow("!")} Verdaccio not running`);
    }

    // Check .npmrc and skip-worktree on linked repos
    const repos = await loadAllRepos();
    for (const { displayName, state } of repos) {
      if (Object.keys(state.packages).length === 0) continue;

      // Check .npmrc has pkglab registry block
      try {
        const npmrcFile = Bun.file(join(state.path, ".npmrc"));
        const exists = await npmrcFile.exists();
        const hasBlock = exists && (await npmrcFile.text()).includes(MARKER_START);

        if (hasBlock) {
          log.line(`  ${c.green("✓")} ${displayName}: .npmrc OK`);
        } else {
          log.line(
            `  ${c.yellow("!")} ${displayName}: .npmrc ${exists ? "missing registry block" : "missing"}, repairing...`,
          );
          await addRegistryToNpmrc(state.path, config.port);
          log.line(`  ${c.green("✓")} ${displayName}: .npmrc repaired`);
        }
      } catch (err) {
        log.line(`  ${c.red("✗")} ${displayName}: could not check .npmrc (${err instanceof Error ? err.message : err})`);
        issues++;
      }

      // Check skip-worktree
      try {
        const hasFlag = await isSkipWorktreeSet(state.path);
        if (hasFlag) {
          log.line(`  ${c.green("✓")} ${displayName}: skip-worktree OK`);
        } else {
          log.line(
            `  ${c.yellow("!")} ${displayName}: skip-worktree missing, repairing...`,
          );
          await applySkipWorktree(state.path);
          log.line(`  ${c.green("✓")} ${displayName}: skip-worktree repaired`);
        }
      } catch {
        log.line(`  ${c.red("✗")} ${displayName}: could not check skip-worktree`);
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
