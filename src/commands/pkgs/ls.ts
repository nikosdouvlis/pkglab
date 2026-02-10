import { defineCommand } from "citty";
import { getDaemonStatus } from "../../lib/daemon";
import { loadConfig } from "../../lib/config";
import { listAllPackages } from "../../lib/registry";
import { ispkglabVersion, extractTimestamp } from "../../lib/version";
import { log } from "../../lib/log";
import { DaemonNotRunningError } from "../../lib/errors";
import pc from "picocolors";

export default defineCommand({
  meta: { name: "ls", description: "List packages in Verdaccio" },
  async run() {
    const status = await getDaemonStatus();
    if (!status?.running) throw new DaemonNotRunningError();

    const config = await loadConfig();
    const packages = await listAllPackages(config);

    if (packages.length === 0) {
      log.info("No packages published to Verdaccio");
      return;
    }

    for (const pkg of packages) {
      const pkglabVersions = pkg.versions
        .filter(ispkglabVersion)
        .sort((a, b) => extractTimestamp(b) - extractTimestamp(a));

      if (pkglabVersions.length === 0) continue;

      const latest = pkglabVersions[0];
      const count = pkglabVersions.length;
      log.line(
        `  ${pkg.name.padEnd(30)} ${pc.green(latest)}  ${pc.dim(`(${count} version${count !== 1 ? "s" : ""})`)}`,
      );
    }
  },
});
