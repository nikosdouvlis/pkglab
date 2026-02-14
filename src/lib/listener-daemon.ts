import { unlink } from "node:fs/promises";
import {
  getListenerSocketPath,
  getListenerPidPath,
  isListenerRunning,
} from "./listener-ipc";
import { isProcessAlive, run } from "./proc";
import { log } from "./log";
import { ensureDaemonRunning } from "./daemon";

export interface ListenerInfo {
  pid: number;
  running: boolean;
  workspaceRoot: string;
}

export async function getListenerDaemonStatus(
  workspaceRoot: string
): Promise<ListenerInfo | null> {
  const pidPath = getListenerPidPath(workspaceRoot);
  const pidFile = Bun.file(pidPath);
  if (!(await pidFile.exists())) return null;

  try {
    const data = JSON.parse(await pidFile.text());
    const pid = data.pid as number;
    if (!pid || !isProcessAlive(pid)) {
      await unlink(pidPath).catch(() => {});
      return null;
    }
    // Validate PID is actually our listener (not a recycled PID)
    if (data.startedAt) {
      const result = await run(["ps", "-p", String(pid), "-o", "lstart="], {});
      if (result.exitCode !== 0) {
        await unlink(pidPath).catch(() => {});
        return null;
      }
      const psTime = new Date(result.stdout.trim()).getTime();
      if (Math.abs(psTime - data.startedAt) > 5000) {
        await unlink(pidPath).catch(() => {});
        return null;
      }
    }
    return {
      pid,
      running: true,
      workspaceRoot: data.workspaceRoot ?? workspaceRoot,
    };
  } catch {
    await unlink(pidPath).catch(() => {});
    return null;
  }
}

export async function startListenerDaemon(
  workspaceRoot: string
): Promise<ListenerInfo> {
  // Ensure Verdaccio is running first
  await ensureDaemonRunning();

  const socketPath = getListenerSocketPath(workspaceRoot);

  // Check if already running
  if (await isListenerRunning(socketPath)) {
    const status = await getListenerDaemonStatus(workspaceRoot);
    if (status) return status;
  }

  // Build command: same pattern as daemon.ts startDaemon()
  const isSource = process.argv[1]?.match(/\.(ts|js)$/);
  const cmd = isSource
    ? [process.execPath, process.argv[1], "--__listener", workspaceRoot]
    : [process.execPath, "--__listener", workspaceRoot];

  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for READY signal, process exit, or timeout
  const deadline = timeout(5000);
  const result = await Promise.race([
    waitForReady(proc),
    waitForExit(proc),
    deadline.promise,
  ]);
  deadline.cancel();

  if (result !== "ready") {
    proc.kill();
    if (result === "timeout") {
      throw new Error("Listener failed to start within 5 seconds");
    }
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Listener process exited unexpectedly: ${stderr}`);
  }

  proc.unref();

  const status = await getListenerDaemonStatus(workspaceRoot);
  return status ?? { pid: proc.pid, running: true, workspaceRoot };
}

export async function ensureListenerRunning(
  workspaceRoot: string
): Promise<void> {
  const socketPath = getListenerSocketPath(workspaceRoot);
  if (await isListenerRunning(socketPath)) return;

  log.info("Starting listener...");
  const info = await startListenerDaemon(workspaceRoot);
  log.success(`Listener running (PID ${info.pid})`);
}

export async function stopListener(workspaceRoot: string): Promise<void> {
  const status = await getListenerDaemonStatus(workspaceRoot);
  if (!status?.running) return;

  process.kill(status.pid, "SIGTERM");

  // Wait for process to exit
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(250);
    if (!isProcessAlive(status.pid)) break;
  }

  // Force kill if still alive
  if (isProcessAlive(status.pid)) {
    process.kill(status.pid, "SIGKILL");
  }

  const pidPath = getListenerPidPath(workspaceRoot);
  const socketPath = getListenerSocketPath(workspaceRoot);
  await unlink(pidPath).catch(() => {});
  await unlink(socketPath).catch(() => {});
}

// Helper functions (same pattern as daemon.ts)

async function waitForReady(
  proc: ReturnType<typeof Bun.spawn>
): Promise<"ready"> {
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === "number") {
    throw new Error("stdout is not a readable stream");
  }
  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stdout closed before READY");
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("READY")) return "ready";
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>
): Promise<"exited"> {
  await proc.exited;
  return "exited";
}

function timeout(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(timer!) };
}
