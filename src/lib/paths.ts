import { homedir } from "node:os";
import { join } from "node:path";

const pkglab_HOME = join(homedir(), ".pkglab");

export const paths = {
  home: pkglab_HOME,
  config: join(pkglab_HOME, "config.json"),
  pid: join(pkglab_HOME, "pid"),
  publishLock: join(pkglab_HOME, "publish.lock"),
  reposDir: join(pkglab_HOME, "repos"),
  verdaccioDir: join(pkglab_HOME, "verdaccio"),
  verdaccioConfig: join(pkglab_HOME, "verdaccio", "config.yaml"),
  verdaccioStorage: join(pkglab_HOME, "verdaccio", "storage"),
  logFile: "/tmp/pkglab/verdaccio.log",
  logDir: "/tmp/pkglab",
} as const;
