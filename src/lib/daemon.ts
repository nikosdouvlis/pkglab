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

  // Wait for READY signal
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let ready = false;
  const timeout = setTimeout(() => {
    if (!ready) {
      proc.kill();
      throw new Error("Verdaccio failed to start within 10 seconds");
    }
  }, 10000);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    if (text.includes("READY")) {
      ready = true;
      clearTimeout(timeout);
      break;
    }
  }

  // Write PID
  await Bun.write(paths.pid, String(proc.pid));

  // Unref so parent can exit
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
    return output.includes("verdaccio-worker") || output.includes("verdaccio");
  } catch {
    return false;
  }
}
