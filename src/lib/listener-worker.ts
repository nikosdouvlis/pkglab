import { join } from "node:path";
import { appendFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import {
  getListenerSocketPath,
  getListenerPidPath,
  getListenerLogPath,
  isListenerRunning,
} from "./listener-ipc";
import { createListener, type ListenerLogger } from "./listener-core";

export async function main(workspaceRoot: string): Promise<void> {
  const socketPath = getListenerSocketPath(workspaceRoot);
  const pidPath = getListenerPidPath(workspaceRoot);
  const logPath = getListenerLogPath(workspaceRoot);

  // Ensure log directory exists
  mkdirSync(join(logPath, ".."), { recursive: true });

  // Check if already running
  if (await isListenerRunning(socketPath)) {
    console.error("Listener already running for this workspace");
    process.exit(1);
  }

  // Clean stale socket
  try {
    unlinkSync(socketPath);
  } catch {}

  // Write PID file
  writeFileSync(
    pidPath,
    JSON.stringify({
      pid: process.pid,
      workspaceRoot,
      startedAt: Date.now(),
    })
  );

  // Create logger that writes to log file
  const writeLog = (level: string, msg: string) => {
    const ts = new Date().toISOString();
    appendFileSync(logPath, `${ts} [${level}] ${msg}\n`);
  };

  const logger: ListenerLogger = {
    info: (msg) => writeLog("INFO", msg),
    success: (msg) => writeLog("OK", msg),
    error: (msg) => writeLog("ERR", msg),
    dim: (msg) => writeLog("DEBUG", msg),
  };

  const handle = createListener({
    socketPath,
    workspaceRoot,
    verbose: false,
    logger,
  });

  // Clean up on exit
  const cleanup = () => {
    handle.stop();
    try {
      unlinkSync(socketPath);
    } catch {}
    try {
      unlinkSync(pidPath);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Signal ready to parent process
  console.log("READY");
}
