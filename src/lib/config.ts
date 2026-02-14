import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { pkglabConfig } from '../types';

import { log } from './log';
import { paths } from './paths';

const CURRENT_CONFIG_VERSION = 1;

const DEFAULT_CONFIG: pkglabConfig = {
  version: CURRENT_CONFIG_VERSION,
  port: 16180,
  prune_keep: 3,
};

export async function ensurepkglabDirs(): Promise<void> {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.reposDir, { recursive: true });
  await mkdir(paths.verdaccioDir, { recursive: true });
  await mkdir(paths.listenersDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
}

export async function loadConfig(): Promise<pkglabConfig> {
  // Check for old YAML config (pre-JSON migration)
  const oldConfigPath = join(paths.home, 'config.yaml');
  const oldConfigFile = Bun.file(oldConfigPath);
  if (await oldConfigFile.exists()) {
    log.error('Incompatible pkglab data format detected (config.yaml is no longer supported).');
    log.error('Run: pkglab reset --hard');
    process.exit(1);
  }

  const file = Bun.file(paths.config);
  if (!(await file.exists())) {
    await Bun.write(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return { ...DEFAULT_CONFIG };
  }

  const text = await file.text();
  const parsed = JSON.parse(text) as Partial<pkglabConfig>;

  if (!parsed.version || parsed.version < CURRENT_CONFIG_VERSION) {
    log.error('Incompatible pkglab config version.');
    log.error('Run: pkglab reset --hard');
    process.exit(1);
  }

  return { ...DEFAULT_CONFIG, ...parsed };
}
