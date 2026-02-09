import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { pruneAll } from "../lib/prune";
import { log } from "../lib/log";
import { DaemonNotRunningError } from "../lib/errors";

export default defineCommand({
  meta: { name: "prune", description: "Clean old package versions" },
  async run() {
    const status = await getDaemonStatus();
    if (!status?.running) throw new DaemonNotRunningError();

    const config = await loadConfig();
    log.info("Pruning old versions...");
    const count = await pruneAll(config);
    if (count > 0) {
      log.success(`Pruned ${count} old version${count !== 1 ? "s" : ""}`);
    } else {
      log.info("Nothing to prune");
    }
  },
});
