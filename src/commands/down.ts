import { defineCommand } from "citty";
import { stopDaemon, getDaemonStatus } from "../lib/daemon";
import { stopListener, getListenerDaemonStatus } from "../lib/listener-daemon";
import { discoverWorkspace } from "../lib/workspace";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "down", description: "Stop pkglab services" },
  async run() {
    // Stop listener if running (needs workspace context)
    try {
      const workspace = await discoverWorkspace(process.cwd());
      const listenerStatus = await getListenerDaemonStatus(workspace.root);
      if (listenerStatus?.running) {
        await stopListener(workspace.root);
        log.success("Listener stopped");
      }
    } catch {
      // Not in a workspace, no listener to stop
    }

    // Stop Verdaccio
    const status = await getDaemonStatus();
    if (!status?.running) {
      log.warn("Verdaccio is not running");
      return;
    }
    await stopDaemon();
    log.success("Verdaccio stopped");
  },
});
