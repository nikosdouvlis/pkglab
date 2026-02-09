import type { PkglConfig } from "../types";
import { getPackageVersions, listAllPackages, unpublishVersion } from "./registry";
import { getActiveRepos } from "./repo-state";
import { isPkglVersion, extractTimestamp } from "./version";
import { log } from "./log";

export async function prunePackage(
  config: PkglConfig,
  pkgName: string
): Promise<number> {
  const versions = await getPackageVersions(config, pkgName);
  const pkglVersions = versions
    .filter(isPkglVersion)
    .sort((a, b) => extractTimestamp(b) - extractTimestamp(a));

  if (pkglVersions.length <= config.prune_keep) return 0;

  const activeRepos = await getActiveRepos();
  const referenced = new Set<string>();
  for (const { state } of activeRepos) {
    for (const link of Object.values(state.packages)) {
      referenced.add(link.current);
    }
  }

  const toRemove = pkglVersions
    .slice(config.prune_keep)
    .filter((v) => !referenced.has(v));

  for (const version of toRemove) {
    await unpublishVersion(config, pkgName, version);
    log.dim(`  Pruned ${pkgName}@${version}`);
  }

  return toRemove.length;
}

export async function pruneAll(config: PkglConfig): Promise<number> {
  const packages = await listAllPackages(config);
  let total = 0;
  for (const pkg of packages) {
    const pkglVersions = pkg.versions.filter(isPkglVersion);
    if (pkglVersions.length > 0) {
      total += await prunePackage(config, pkg.name);
    }
  }
  return total;
}
