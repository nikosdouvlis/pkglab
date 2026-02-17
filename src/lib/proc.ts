/**
 * Whether we're running from source (bun src/index.ts) vs a compiled binary.
 * In source mode, process.execPath IS the bun runtime.
 * In compiled mode, process.execPath is the pkglab binary itself.
 */
const isSourceMode = !!process.argv[1]?.match(/\.(ts|js)$/);

/**
 * Resolve the path to the bun runtime binary.
 *
 * In source mode, process.execPath is already bun.
 * In compiled mode, we search PATH via Bun.which().
 *
 * Used for commands that need the bun runtime (publish, run), NOT for
 * spawning pkglab's own subcommands (use process.execPath for those).
 */
export function resolveRuntime(): string {
  if (isSourceMode) return process.execPath;

  const bun = Bun.which('bun');
  if (bun) return bun;

  throw new Error(
    'Could not find bun in PATH. The compiled pkglab binary needs bun installed ' +
    'for publishing. Install bun (https://bun.sh) or add setup-bun to your CI.',
  );
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function run(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Drain pipes concurrently with waiting for exit to avoid deadlocks
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Shared daemon lifecycle helpers

export async function waitForReady(proc: ReturnType<typeof Bun.spawn>): Promise<'ready'> {
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === 'number') {
    throw new Error('stdout is not a readable stream');
  }
  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error('stdout closed before READY');
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('READY')) {
        return 'ready';
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function waitForExit(proc: ReturnType<typeof Bun.spawn>): Promise<'exited'> {
  await proc.exited;
  return 'exited';
}

export function timeout(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return { promise, cancel: () => clearTimeout(timer!) };
}

export async function gracefulStop(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  for (let i = 0; i < 20; i++) {
    await Bun.sleep(250);
    if (!isProcessAlive(pid)) {
      return;
    }
  }

  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

export async function validatePidStartTime(pid: number, startedAt: number): Promise<boolean> {
  try {
    const result = await run(['ps', '-p', String(pid), '-o', 'lstart='], {});
    if (result.exitCode !== 0) {
      return false;
    }
    const psTime = new Date(result.stdout.trim()).getTime();
    if (!Number.isFinite(psTime)) {
      return false;
    }
    return Math.abs(psTime - startedAt) < 5000;
  } catch {
    return false;
  }
}
