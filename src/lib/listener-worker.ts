import { appendFileSync, writeFileSync, mkdirSync, unlinkSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { createListener, type ListenerLogger } from './listener-core';
import { getListenerSocketPath, getListenerPidPath, getListenerLogPath, isListenerRunning } from './listener-ipc';

export async function main(workspaceRoot: string): Promise<void> {
  const socketPath = getListenerSocketPath(workspaceRoot);
  const pidPath = getListenerPidPath(workspaceRoot);
  const logPath = getListenerLogPath(workspaceRoot);

  // Ensure log directory exists
  mkdirSync(join(logPath, '..'), { recursive: true });

  // Check if already running
  if (await isListenerRunning(socketPath)) {
    console.error('Listener already running for this workspace');
    process.exit(1);
  }

  // Clean stale socket
  try {
    unlinkSync(socketPath);
  } catch {}

  // Create logger that writes to log file
  const writeLog = (level: string, msg: string) => {
    const ts = new Date().toISOString();
    appendFileSync(logPath, `${ts} [${level}] ${msg}\n`);
  };

  const logger: ListenerLogger = {
    info: msg => writeLog('INFO', msg),
    success: msg => writeLog('OK', msg),
    error: msg => writeLog('ERR', msg),
    dim: msg => writeLog('DEBUG', msg),
  };

  // Open log file for child process stdout/stderr redirection
  const logFd = openSync(logPath, 'a');

  const handle = createListener({
    socketPath,
    workspaceRoot,
    verbose: false,
    logger,
    childStdout: logFd,
    childStderr: logFd,
  });

  // Write PID file AFTER socket is successfully bound
  writeFileSync(
    pidPath,
    JSON.stringify({
      pid: process.pid,
      workspaceRoot,
      startedAt: Date.now(),
    }),
  );

  // Signal ready AFTER PID is written
  console.log('READY');

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
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
