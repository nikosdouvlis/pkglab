#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { runServer } from 'verdaccio';

import { loadConfig, ensurepkglabDirs } from './config';
import { paths } from './paths';
import { buildVerdaccioConfig } from './verdaccio-config';

export async function main() {
  await ensurepkglabDirs();
  await mkdir(paths.verdaccioStorage, { recursive: true });

  const config = await loadConfig();
  const verdaccioConfig = buildVerdaccioConfig();

  const app = await runServer(verdaccioConfig);

  app.listen(config.port, '127.0.0.1', () => {
    process.stdout.write('READY\n');
  });
}

// Self-execute when run directly (dev mode: bun src/lib/verdaccio-worker.ts)
if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
