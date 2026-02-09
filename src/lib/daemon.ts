import { paths } from "./paths";
import { loadConfig } from "./config";
import { DaemonAlreadyRunningError } from "./errors";
import type { DaemonInfo } from "../types";

export async function startDaemon(): Promise<DaemonInfo> {
  const existing = await getDaemonStatus();
  if (existing?.running) {
    throw new DaemonAlreadyRunningError(
      `Already running on port ${existing.port} (PID ${existing.pid})`
    );
  }

  // Clean stale PID if exists
  const pidFile = Bun.file(paths.pid);
  if (await pidFile.exists()) {
    const { unlink } = await import("node:fs/promises");
    await unlink(paths.pid);
  }

  const config = await loadConfig();
  const workerPath = new URL("./verdaccio-worker.ts", import.meta.url).pathname;

  const proc = Bun.spawn(["bun", workerPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for READY signal, process exit, or timeout
  const result = await Promise.race([
    waitForReady(proc),
    waitForExit(proc),
    timeout(10000),
  ]);

  if (result !== "ready") {
    proc.kill();
    if (result === "timeout") {
      throw new Error("Verdaccio failed to start within 10 seconds");
    }
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Verdaccio process exited unexpectedly: ${stderr}`);
  }

  // Write PID only after confirmed READY
  await Bun.write(paths.pid, String(proc.pid));
  proc.unref();

  return { pid: proc.pid, port: config.port, running: true };
}

export async function stopDaemon(): Promise<void> {
  const status = await getDaemonStatus();
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

  const { unlink } = await import("node:fs/promises");
  await unlink(paths.pid).catch(() => {});
}

export async function getDaemonStatus(): Promise<DaemonInfo | null> {
  const pidFile = Bun.file(paths.pid);
  if (!(await pidFile.exists())) return null;

  const pidStr = await pidFile.text();
  const pid = parseInt(pidStr.trim(), 10);
  if (isNaN(pid)) return null;

  if (!isProcessAlive(pid)) {
    // Stale PID, clean up
    const { unlink } = await import("node:fs/promises");
    await unlink(paths.pid).catch(() => {});
    return null;
  }

  if (!(await validatePid(pid))) {
    return null;
  }

  const config = await loadConfig();
  return { pid, port: config.port, running: true };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function validatePid(pid: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    // Must match our specific worker script pattern
    return output.includes("verdaccio-worker.ts") || output.includes("bun") && output.includes("verdaccio");
  } catch {
    return false;
  }
}

async function waitForReady(proc: ReturnType<typeof Bun.spawn>): Promise<"ready"> {
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === "number") {
    throw new Error("stdout is not a readable stream");
  }
  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stdout closed before READY");
      if (decoder.decode(value).includes("READY")) return "ready";
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitForExit(proc: ReturnType<typeof Bun.spawn>): Promise<"exited"> {
  await proc.exited;
  return "exited";
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}
