import { defineCommand } from "citty";
import { getDaemonStatus } from "../../lib/daemon";
import { loadConfig } from "../../lib/config";
import { listPackageNames, removePackage } from "../../lib/registry";
import { log } from "../../lib/log";
import { DaemonNotRunningError } from "../../lib/errors";

export default defineCommand({
  meta: { name: "rm", description: "Remove packages from the local registry" },
  args: {
    name: { type: "positional", description: "Package name(s)", required: false },
    all: { type: "boolean", description: "Remove all pkglab packages", default: false },
  },
  async run({ args }) {
    const status = await getDaemonStatus();
    if (!status?.running) throw new DaemonNotRunningError();

    const config = await loadConfig();
    const toRemove = args.all
      ? await listPackageNames()
      : ((args as any)._ as string[] | undefined) ?? [];

    if (args.all && toRemove.length === 0) {
      log.info("No pkglab packages in the registry");
      return;
    }

    if (toRemove.length === 0) {
      log.error("Specify package name(s) or use --all");
      process.exit(1);
    }

    const results = await Promise.all(
      toRemove.map(async (name) => {
        const ok = await removePackage(config, name);
        return { name, ok };
      }),
    );

    for (const { name, ok } of results) {
      if (ok) {
        log.dim(`  Removed ${name}`);
      } else {
        log.warn(`  ${name} not found in registry`);
      }
    }

    const removed = results.filter((r) => r.ok).length;
    if (removed > 0) {
      log.success(`Removed ${removed} package${removed !== 1 ? "s" : ""}`);
    }

    if (args.all) {
      const { clearFingerprintState } = await import("../../lib/fingerprint-state");
      await clearFingerprintState();
    }
  },
});
