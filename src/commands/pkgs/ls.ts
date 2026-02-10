import { defineCommand } from "citty";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getDaemonStatus } from "../../lib/daemon";
import { loadConfig } from "../../lib/config";
import { paths } from "../../lib/paths";
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

    // Read storage and API in parallel
    const [storageVersions, apiResp] = await Promise.all([
      readStorageVersionCounts(paths.verdaccioStorage),
      fetch(`http://127.0.0.1:${config.port}/-/verdaccio/data/packages`),
    ]);

    if (!apiResp.ok) {
      log.info("No packages published to Verdaccio");
      return;
    }

    const data = (await apiResp.json()) as { name: string; version: string }[];
    const pkglab = data.filter((p) => ispkglabVersion(p.version));

    if (pkglab.length === 0) {
      log.info("No packages published to Verdaccio");
      return;
    }

    for (const pkg of pkglab) {
      const count = storageVersions.get(pkg.name) ?? 0;
      const countStr = count > 0 ? `  ${c.dim(`(${count} version${count !== 1 ? "s" : ""})`)}` : "";
      log.line(`  ${pkg.name.padEnd(30)} ${c.green(pkg.version)}${countStr}`);
    }
  },
});

async function readStorageVersionCounts(
  storageDir: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  let entries: string[];
  try {
    entries = await readdir(storageDir);
  } catch {
    return counts;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(storageDir, entry);

      if (entry.startsWith("@")) {
        // Scoped packages: read one level deeper
        let scopedPkgs: string[];
        try {
          scopedPkgs = await readdir(entryPath);
        } catch {
          return;
        }
        await Promise.all(
          scopedPkgs.map(async (pkg) => {
            const count = await countTgz(join(entryPath, pkg));
            if (count > 0) counts.set(`${entry}/${pkg}`, count);
          }),
        );
      } else {
        const count = await countTgz(entryPath);
        if (count > 0) counts.set(entry, count);
      }
    }),
  );

  return counts;
}

async function countTgz(dir: string): Promise<number> {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".tgz")).length;
  } catch {
    return 0;
  }
}
