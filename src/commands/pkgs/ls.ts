import { defineCommand } from "citty";
import { getDaemonStatus } from "../../lib/daemon";
import { loadConfig } from "../../lib/config";
import { ispkglabVersion } from "../../lib/version";
import { log } from "../../lib/log";
import { DaemonNotRunningError } from "../../lib/errors";
import { c } from "../../lib/color";

export default defineCommand({
  meta: { name: "ls", description: "List packages in Verdaccio" },
  async run() {
    const status = await getDaemonStatus();
    if (!status?.running) throw new DaemonNotRunningError();

    const config = await loadConfig();
    const resp = await fetch(
      `http://127.0.0.1:${config.port}/-/verdaccio/data/packages`,
    );
    if (!resp.ok) {
      log.info("No packages published to Verdaccio");
      return;
    }

    const data = (await resp.json()) as { name: string; version: string }[];
    const pkglab = data.filter((p) => ispkglabVersion(p.version));

    if (pkglab.length === 0) {
      log.info("No packages published to Verdaccio");
      return;
    }

    for (const pkg of pkglab) {
      log.line(`  ${pkg.name.padEnd(30)} ${c.green(pkg.version)}`);
    }
  },
});
