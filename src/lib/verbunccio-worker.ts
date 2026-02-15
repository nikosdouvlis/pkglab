import { mkdirSync, openSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { loadConfig, ensurepkglabDirs } from './config';
import { paths } from './paths';
import { setLogFd } from './publish-queue';
import VerbunccioStorage from './verbunccio-storage';
import { handleRequest } from './verbunccio-routes';

export async function main() {
  await ensurepkglabDirs();
  await mkdir(paths.registryStorage, { recursive: true });

  const config = await loadConfig();
  const storage = new VerbunccioStorage();
  await storage.loadAll();

  Bun.serve({
    port: config.port,
    hostname: '127.0.0.1',
    fetch(req) {
      return handleRequest(req, storage, config.port);
    },
  });

  process.stdout.write('READY\n');

  // Redirect console output and child process output to the log file
  // so `pkglab logs -f` can tail registry events (pings, publishes, etc.)
  mkdirSync(dirname(paths.logFile), { recursive: true });
  const logFd = openSync(paths.logFile, 'a');
  setLogFd(logFd);
  const write = (msg: string) => {
    try {
      writeSync(logFd, msg);
    } catch {}
  };
  console.log = (...args: unknown[]) => write(args.map(String).join(' ') + '\n');
  console.error = (...args: unknown[]) => write(args.map(String).join(' ') + '\n');
}

// Self-execute when run directly (dev mode)
if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
