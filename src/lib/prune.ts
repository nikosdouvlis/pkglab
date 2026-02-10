import type { pkglabConfig } from "../types";
import {
  listAllPackages,
  unpublishVersions,
} from "./registry";
import { getActiveRepos } from "./repo-state";
import { ispkglabVersion, extractTimestamp } from "./version";
import { log } from "./log";

export async function prunePackage(
  config: pkglabConfig,
  pkgName: string,
  versions: string[],
  referenced: Set<string>,
): Promise<number> {
  const pkglabVersions = versions
    .filter(ispkglabVersion)
    .sort((a, b) => extractTimestamp(b) - extractTimestamp(a));

  if (pkglabVersions.length <= config.prune_keep) return 0;

  const toRemove = pkglabVersions
    .slice(config.prune_keep)
    .filter((v) => !referenced.has(v));

  if (toRemove.length === 0) return 0;

  const { removed, failed } = await unpublishVersions(config, pkgName, toRemove);
  for (const v of removed) log.dim(`  Pruned ${pkgName}@${v}`);
  for (const v of failed) log.warn(`  Failed to prune ${pkgName}@${v}`);

  return removed.length;
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
    toPrune.map((pkg) => prunePackage(config, pkg.name, pkg.versions, referenced)),
  );

  return results.reduce((sum, n) => sum + n, 0);
}
