import { paths } from "./paths";

export function buildVerdaccioConfig() {
  return {
    self_path: paths.verdaccioDir,
    storage: paths.verdaccioStorage,
    uplinks: {
      npmjs: {
        url: "https://registry.npmjs.org/",
        cache: true,
        timeout: "60s",
        max_fails: 10,
        fail_timeout: "10s",
        strict_ssl: false,
      },
    },
    publish: { allow_offline: true },
    packages: {
      "**": {
        access: "$all",
        publish: "$all",
        unpublish: "$all",
        proxy: "npmjs",
      },
    },
    server: { keepAliveTimeout: 60 },
    log: { type: "file", path: paths.logFile, level: "info" },
    auth: {
      htpasswd: {
        file: paths.verdaccioDir + "/htpasswd",
        max_users: -1,
      },
    },
  };
}
