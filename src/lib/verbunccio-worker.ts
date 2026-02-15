import { mkdir } from 'node:fs/promises';

import { loadConfig, ensurepkglabDirs } from './config';
import { paths } from './paths';
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
}

// Self-execute when run directly (dev mode)
if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
