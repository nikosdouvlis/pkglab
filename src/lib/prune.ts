import type { pkglabConfig } from "../types";
import {
  getPackageVersions,
  listAllPackages,
  unpublishVersion,
} from "./registry";
import { getActiveRepos } from "./repo-state";
import { ispkglabVersion, extractTimestamp } from "./version";
import { log } from "./log";

export async function prunePackage(
  config: pkglabConfig,
  pkgName: string,
  referenced: Set<string>,
): Promise<number> {
  const versions = await getPackageVersions(config, pkgName);
  const pkglabVersions = versions
    .filter(ispkglabVersion)
    .sort((a, b) => extractTimestamp(b) - extractTimestamp(a));

  if (pkglabVersions.length <= config.prune_keep) return 0;

  const toRemove = pkglabVersions
    .slice(config.prune_keep)
    .filter((v) => !referenced.has(v));

  await Promise.all(
    toRemove.map(async (version) => {
      await unpublishVersion(config, pkgName, version);
      log.dim(`  Pruned ${pkgName}@${version}`);
    }),
  );

  return toRemove.length;
}

export async function pruneAll(config: pkglabConfig): Promise<number> {
  const activeRepos = await getActiveRepos();
  const referenced = new Set<string>();
  for (const { state } of activeRepos) {
    for (const link of Object.values(state.packages)) {
      referenced.add(link.current);
    }
  }

  const packages = await listAllPackages(config);
  const toPrune = packages.filter(
    (pkg) => pkg.versions.filter(ispkglabVersion).length > 0,
  );

  const results = await Promise.all(
    toPrune.map((pkg) => prunePackage(config, pkg.name, referenced)),
  );

  return results.reduce((sum, n) => sum + n, 0);
}
