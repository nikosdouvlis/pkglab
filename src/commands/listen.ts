import { defineCommand } from "citty";
import { unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { discoverWorkspace } from "../lib/workspace";
import { ensureDaemonRunning } from "../lib/daemon";
import {
  getListenerSocketPath,
  isListenerRunning,
  type PingMessage,
  type PingAck,
} from "../lib/listener-ipc";
import { pkglabError } from "../lib/errors";
import { log } from "../lib/log";
import { c } from "../lib/color";

interface Lane {
  pending: Set<string>;
  root: boolean;
}

function formatTimestamp(): string {
  return "[" + new Date().toLocaleTimeString("en-GB", { hour12: false }) + "]";
}

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
      throw new pkglabError(
        "Listener already running for this workspace"
      );
    }

    // Clean up stale socket file if it exists
    await unlink(socketPath).catch(() => {});

    // Ensure Verdaccio is running
    await ensureDaemonRunning();

    // Per-tag lane state for coalescing pings
    const lanes = new Map<string, Lane>();
    let publishing = false;

    function getLane(tag: string): Lane {
      let lane = lanes.get(tag);
      if (!lane) {
        lane = { pending: new Set(), root: false };
        lanes.set(tag, lane);
      }
      return lane;
    }

    function handlePing(msg: PingMessage): void {
      const tag = msg.tag ?? "";
      const lane = getLane(tag);

      for (const name of msg.names) {
        lane.pending.add(name);
      }
      if (msg.root) lane.root = true;

      if (publishing) {
        const names = msg.names.length > 0 ? msg.names.join(", ") : "(root)";
        log.info(
          formatTimestamp() +
            " Ping: " +
            names +
            (tag ? ` [${tag}]` : "") +
            " (queued, publish in progress)"
        );
      } else {
        const names = msg.names.length > 0 ? msg.names.join(", ") : "(root)";
        log.info(
          formatTimestamp() + " Ping: " + names + (tag ? ` [${tag}]` : "")
        );
        drainLanes();
      }
    }

    async function drainLanes(): Promise<void> {
      publishing = true;
      try {
        while (true) {
          // Find next lane with pending work
          let activeLane: Lane | undefined;
          let activeTag = "";
          for (const [tag, lane] of lanes) {
            if (lane.pending.size > 0 || lane.root) {
              activeLane = lane;
              activeTag = tag;
              break;
            }
          }
          if (!activeLane) break;

          // Drain this lane's pending set
          const names = [...activeLane.pending];
          const useRoot = activeLane.root;
          activeLane.pending.clear();
          activeLane.root = false;

          // Build command
          const cmd: string[] = [process.execPath];
          const isSource = process.argv[1]?.match(/\.(ts|js)$/);
          if (isSource) cmd.push(process.argv[1]);
          cmd.push("pub");

          if (useRoot) {
            cmd.push("--root");
          } else if (names.length > 0) {
            cmd.push(...names);
          }

          if (activeTag) {
            cmd.push("--tag", activeTag);
          }

          log.info(
            formatTimestamp() +
              " Publishing" +
              (activeTag ? ` [${activeTag}]` : "") +
              "..."
          );
          if (names.length > 0 && !useRoot) {
            log.dim("  " + names.join(", "));
          }

          const proc = Bun.spawn(cmd, {
            cwd: workspaceRoot,
            stdout: "inherit",
            stderr: "inherit",
          });

          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            log.error(
              formatTimestamp() + " Publish failed (exit " + exitCode + ")"
            );
          } else {
            log.success(formatTimestamp() + " Publish complete");
          }
        }
      } finally {
        publishing = false;
      }
    }

    // Per-socket receive buffer for TCP frame reassembly
    const socketBuffers = new Map<object, string>();

    // Start Unix socket server
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(_socket) {
          if (args.verbose) {
            log.dim(formatTimestamp() + " Connection opened");
          }
        },
        data(socket, data) {
          let buffer = (socketBuffers.get(socket) ?? "") + data.toString();
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              if (!Array.isArray(msg.names)) {
                throw new Error("Invalid ping: names must be an array");
              }
              const ack: PingAck = { ok: true };
              socket.write(JSON.stringify(ack) + "\n");
              socket.flush();
              handlePing(msg as PingMessage);
            } catch (err) {
              const ack: PingAck = {
                ok: false,
                error: err instanceof Error ? err.message : "Parse error",
              };
              socket.write(JSON.stringify(ack) + "\n");
              socket.flush();
              if (args.verbose) {
                log.error(
                  formatTimestamp() + " Bad message: " + line
                );
              }
            }
          }
          socketBuffers.set(socket, buffer);
        },
        close(socket) {
          socketBuffers.delete(socket);
          if (args.verbose) {
            log.dim(formatTimestamp() + " Connection closed");
          }
        },
        error(_socket, error) {
          if (args.verbose) {
            log.error(
              formatTimestamp() + " Socket error: " + error.message
            );
          }
        },
      },
    });

    const cleanup = () => {
      server.stop();
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
