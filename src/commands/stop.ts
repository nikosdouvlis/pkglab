import { defineCommand } from "citty";
import { stopDaemon, getDaemonStatus } from "../lib/daemon";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "down", description: "Stop Verdaccio daemon" },
  async run() {
    const status = await getDaemonStatus();
    if (!status?.running) {
      log.warn("Verdaccio is not running");
      return;
    }
    await stopDaemon();
    log.success("Verdaccio stopped");
  },
});
