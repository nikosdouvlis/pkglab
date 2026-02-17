import { homedir } from 'node:os';
import { join } from 'node:path';

const pkglab_HOME = join(homedir(), '.pkglab');

export const paths = {
  home: pkglab_HOME,
  config: join(pkglab_HOME, 'config.json'),
  pid: join(pkglab_HOME, 'pid'),
  publishLock: join(pkglab_HOME, 'publish.lock'),
  reposDir: join(pkglab_HOME, 'repos'),
  registryDir: join(pkglab_HOME, 'registry'),
  registryStorage: join(pkglab_HOME, 'registry', 'storage'),
  listenersDir: join(pkglab_HOME, 'listeners'),
  logFile: '/tmp/pkglab/registry.log',
  logDir: '/tmp/pkglab',
} as const;
