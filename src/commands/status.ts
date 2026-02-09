import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "status", description: "Show server info and status" },
  async run() {
    const config = await loadConfig();
    const status = await getDaemonStatus();

    if (status?.running) {
      log.success(`Verdaccio running on http://127.0.0.1:${config.port} (PID ${status.pid})`);
    } else {
      log.info("Verdaccio is not running");
    }
  },
});
