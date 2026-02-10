import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { pruneAll } from "../lib/prune";
import { log } from "../lib/log";
import { DaemonNotRunningError } from "../lib/errors";

export default defineCommand({
  meta: { name: "prune", description: "Clean old package versions" },
  args: {
    all: { type: "boolean", description: "Remove all pkglab versions (ignore prune_keep)", default: false },
  },
  async run({ args }) {
    const status = await getDaemonStatus();
    if (!status?.running) throw new DaemonNotRunningError();

    const config = await loadConfig();
    if (args.all) config.prune_keep = 0;

    log.info(args.all ? "Removing all pkglab versions..." : "Pruning old versions...");
    const count = await pruneAll(config);
    if (count > 0) {
      log.success(`Pruned ${count} version${count !== 1 ? "s" : ""}`);
    } else {
      log.info("Nothing to prune");
    }
  },
});
