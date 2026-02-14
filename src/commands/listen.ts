import { defineCommand } from "citty";
import { unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { discoverWorkspace } from "../lib/workspace";
import { ensureDaemonRunning } from "../lib/daemon";
import {
  getListenerSocketPath,
  isListenerRunning,
} from "../lib/listener-ipc";
import { createListener, type ListenerLogger } from "../lib/listener-core";
import { pkglabError } from "../lib/errors";
import { log } from "../lib/log";
import { c } from "../lib/color";

export default defineCommand({
  meta: {
    name: "listen",
    description: "Listen for publish signals (coordinator mode)",
  },
  args: {
    verbose: {
      type: "boolean",
      description: "Show detailed output",
      default: false,
      alias: "v",
    },
  },
  async run({ args }) {
    const workspace = await discoverWorkspace(process.cwd());
    const workspaceRoot = workspace.root;
    const socketPath = getListenerSocketPath(workspaceRoot);

    // Check if a listener is already running for this workspace
    if (await isListenerRunning(socketPath)) {
      throw new pkglabError("Listener already running for this workspace");
    }

    // Clean up stale socket file if it exists
    await unlink(socketPath).catch(() => {});

    // Ensure Verdaccio is running
    await ensureDaemonRunning();

    const logger: ListenerLogger = {
      info: (msg) => log.info(msg),
      success: (msg) => log.success(msg),
      error: (msg) => log.error(msg),
      dim: (msg) => log.dim(msg),
    };

    const handle = createListener({
      socketPath,
      workspaceRoot,
      verbose: args.verbose as boolean,
      logger,
    });

    const cleanup = () => {
      handle.stop();
      try { unlinkSync(socketPath); } catch {}
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    console.log();
    log.line(
      c.blue("pkglab") +
        " listening on " +
        c.dim(socketPath)
    );
    log.dim("  Workspace: " + workspaceRoot);
    console.log();

    // Keep process alive
    await new Promise(() => {});
  },
});
