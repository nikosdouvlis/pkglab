import { paths } from "./paths";
import type { PkglConfig } from "../types";

export function buildVerdaccioConfig(config: PkglConfig) {
  return {
    self_path: paths.verdaccioDir,
    storage: paths.verdaccioStorage,
    uplinks: {
      npmjs: {
        url: "https://registry.npmjs.org/",
        cache: true,
      },
    },
    packages: {
      "**": {
        access: "$all",
        publish: "$all",
        unpublish: "$all",
        proxy: "npmjs",
      },
    },
    server: { keepAliveTimeout: 60 },
    logs: { type: "file", path: paths.logFile, level: "info" },
    auth: {
      htpasswd: {
        file: paths.verdaccioDir + "/htpasswd",
        max_users: -1,
      },
    },
  };
}
