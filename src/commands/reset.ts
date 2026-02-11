import { defineCommand } from "citty";
import { rm } from "node:fs/promises";
import { getDaemonStatus, stopDaemon } from "../lib/daemon";
import { paths } from "../lib/paths";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "reset", description: "Reset pkglab state" },
  args: {
    hard: {
      type: "boolean",
      description: "Wipe all pkglab data and Verdaccio storage",
      default: false,
    },
  },
  async run({ args }) {
    if (!args.hard) {
      log.error("Use --hard to confirm: pkglab reset --hard");
      process.exit(1);
    }

    const status = await getDaemonStatus();
    if (status?.running) {
      await stopDaemon();
      log.info("Stopped registry");
    }

    await rm(paths.home, { recursive: true, force: true });
    log.success("Reset complete. All pkglab data wiped.");
  },
});
