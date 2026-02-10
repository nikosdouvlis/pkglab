import { paths } from "./paths";
import { loadConfig } from "./config";
import { DaemonAlreadyRunningError } from "./errors";
import type { DaemonInfo } from "../types";
import { isProcessAlive, run } from "./proc";

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

  // In compiled mode, process.argv[1] is a subcommand (e.g. "up").
  // In source mode, process.argv[1] is the script path (e.g. "src/index.ts").
  const isSource = process.argv[1]?.match(/\.(ts|js)$/);
  const cmd = isSource
    ? [process.execPath, process.argv[1], "--__worker"]
    : [process.execPath, "--__worker"];

  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for READY signal, process exit, or timeout
  const deadline = timeout(10000);
  const result = await Promise.race([
    waitForReady(proc),
    waitForExit(proc),
    deadline.promise,
  ]);
  deadline.cancel();

  if (result !== "ready") {
    proc.kill();
    if (result === "timeout") {
      throw new Error("Verdaccio failed to start within 10 seconds");
    }
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Verdaccio process exited unexpectedly: ${stderr}`);
  }

  // Write PID only after confirmed READY
  await Bun.write(paths.pid, JSON.stringify({ pid: proc.pid, port: config.port, startedAt: Date.now() }));
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

  const content = await pidFile.text();
  let pid: number;
  let port: number | undefined;
  let startedAt: number | undefined;

  try {
    const data = JSON.parse(content.trim());
    pid = data.pid;
    port = data.port;
    startedAt = data.startedAt;
  } catch {
    // Legacy plain-number format
    pid = parseInt(content.trim(), 10);
  }

  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return null;

  if (!isProcessAlive(pid)) {
    const { unlink } = await import("node:fs/promises");
    await unlink(paths.pid).catch(() => {});
    return null;
  }

  if (!(await validatePid(pid, startedAt))) {
    const { unlink } = await import("node:fs/promises");
    await unlink(paths.pid).catch(() => {});
    return null;
  }

  const config = await loadConfig();
  return { pid, port: port ?? config.port, running: true };
}

async function validatePid(pid: number, startedAt?: number): Promise<boolean> {
  if (startedAt) {
    // Use process start time comparison: if the process was started
    // within a reasonable window of our recorded time, it's likely ours
    try {
      const result = await run(["ps", "-p", String(pid), "-o", "lstart="], {});
      if (result.exitCode !== 0) return false;
      const psTime = new Date(result.stdout.trim()).getTime();
      // Allow 5 second tolerance for start time difference
      return Math.abs(psTime - startedAt) < 5000;
    } catch {
      return false;
    }
  }
  // Fallback: check command string (legacy pidfiles without startedAt)
  try {
    const result = await run(["ps", "-p", String(pid), "-o", "command="], {});
    if (result.exitCode !== 0) return false;
    return result.stdout.includes("verdaccio-worker") || (result.stdout.includes("bun") && result.stdout.includes("verdaccio"));
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

async function waitForExit(proc: ReturnType<typeof Bun.spawn>): Promise<"exited"> {
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
