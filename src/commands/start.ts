import { defineCommand } from "citty";
import { startDaemon, getDaemonStatus } from "../lib/daemon";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "start", description: "Start Verdaccio daemon" },
  async run() {
    const existing = await getDaemonStatus();
    if (existing?.running) {
      log.warn(`Already running on port ${existing.port} (PID ${existing.pid})`);
      return;
    }

    log.info("Starting Verdaccio...");
    const info = await startDaemon();
    log.success(`pkgl running on http://127.0.0.1:${info.port} (PID ${info.pid})`);
  },
});
