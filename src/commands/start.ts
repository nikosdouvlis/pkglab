import { defineCommand } from "citty";
import { startDaemon, getDaemonStatus } from "../lib/daemon";
import { log } from "../lib/log";
import { prefetchUpdateCheck } from "../lib/update-check";

export default defineCommand({
  meta: { name: "up", description: "Start Verdaccio daemon" },
  async run() {
    const existing = await getDaemonStatus();
    if (existing?.running) {
      log.warn(
        `Already running on port ${existing.port} (PID ${existing.pid})`,
      );
      const { ensureNpmrcForActiveRepos } = await import("../lib/consumer");
      await ensureNpmrcForActiveRepos(existing.port);
      return;
    }

    // Start fetch before interactive prompt so it runs in parallel
    const showUpdate = await prefetchUpdateCheck();

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
      // Propagate port to .npmrc in linked repos
      const { addRegistryToNpmrc, applySkipWorktree } = await import("../lib/consumer");
      for (const [name, state] of entries) {
        if (Object.keys(state.packages).length > 0) {
          try {
            await addRegistryToNpmrc(state.path, info.port);
          } catch {
            log.warn(`Could not update .npmrc for ${name}`);
          }
        }
      }

      const { selectRepos } = await import("../lib/prompt");
      const selected = await selectRepos({
        message: "Select repos to activate",
      });

      if (selected.length > 0) {
        const { saveRepoState } = await import("../lib/repo-state");
        for (const { name, state } of selected) {
          await addRegistryToNpmrc(state.path, info.port);
          await applySkipWorktree(state.path);
          state.active = true;
          state.lastUsed = Date.now();
          await saveRepoState(name, state);
          log.success(`Activated ${name}`);
        }
      }
    }

    await showUpdate();
  },
});
