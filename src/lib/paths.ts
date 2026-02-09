import { homedir } from "node:os";
import { join } from "node:path";

const PKGL_HOME = join(homedir(), ".pkgl");

export const paths = {
  home: PKGL_HOME,
  config: join(PKGL_HOME, "config.yaml"),
  pid: join(PKGL_HOME, "pid"),
  publishLock: join(PKGL_HOME, "publish.lock"),
  reposDir: join(PKGL_HOME, "repos"),
  verdaccioDir: join(PKGL_HOME, "verdaccio"),
  verdaccioConfig: join(PKGL_HOME, "verdaccio", "config.yaml"),
  verdaccioStorage: join(PKGL_HOME, "verdaccio", "storage"),
  logFile: "/tmp/pkgl/verdaccio.log",
  logDir: "/tmp/pkgl",
} as const;
