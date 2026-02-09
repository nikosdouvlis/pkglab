import { defineCommand } from "citty";
import { paths } from "../lib/paths";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "logs", description: "Tail Verdaccio logs" },
  args: {
    follow: { type: "boolean", alias: "f", description: "Stream logs", default: false },
  },
  async run({ args }) {
    const file = Bun.file(paths.logFile);
    if (!(await file.exists())) {
      log.warn("No log file found. Has Verdaccio been started?");
      return;
    }

    const cmd = args.follow
      ? ["tail", "-f", paths.logFile]
      : ["tail", "-50", paths.logFile];

    const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
    await proc.exited;
  },
});
