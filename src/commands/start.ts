import { defineCommand } from "citty";
import { startDaemon, getDaemonStatus } from "../lib/daemon";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "up", description: "Start Verdaccio daemon" },
  async run() {
    const existing = await getDaemonStatus();
    if (existing?.running) {
      log.warn(
        `Already running on port ${existing.port} (PID ${existing.pid})`,
      );
      return;
    }

    log.info("Starting Verdaccio...");
    const info = await startDaemon();
    log.success(
      `pkglab running on http://127.0.0.1:${info.port} (PID ${info.pid})`,
    );

    const { deactivateAllRepos, loadAllRepos } =
      await import("../lib/repo-state");
    await deactivateAllRepos();

    const repos = await loadAllRepos();
    const entries = Object.entries(repos);
    if (entries.length > 0) {
      log.info("\nLinked repos (all inactive):");
      for (const [name, state] of entries) {
        log.line(`  ${name.padEnd(20)} ${state.path}`);
      }
      log.dim("\nActivate repos: pkglab repos activate <name>");
    }

    // Propagate port to .npmrc in linked repos
    const { addRegistryToNpmrc } = await import("../lib/consumer");
    for (const [name, state] of entries) {
      if (Object.keys(state.packages).length > 0) {
        try {
          await addRegistryToNpmrc(state.path, info.port);
        } catch {
          log.warn(`Could not update .npmrc for ${name}`);
        }
      }
    }
  },
});
