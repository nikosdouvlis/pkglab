import type { pkglabConfig } from '../types';

import { log } from './log';
import { listAllPackages, unpublishVersions } from './registry';
import { getActiveRepos } from './repo-state';
import { ispkglabVersion, extractTimestamp, extractTag } from './version';

export async function prunePackage(
  config: pkglabConfig,
  pkgName: string,
  versions: string[],
  referenced: Set<string>,
  onlyTag?: string | null,
): Promise<number> {
  const pkglabVersions = versions.filter(ispkglabVersion);

  // Group by tag
  const groups = new Map<string | null, string[]>();
  for (const v of pkglabVersions) {
    const tag = extractTag(v);
    const group = groups.get(tag) || [];
    group.push(v);
    groups.set(tag, group);
  }

  // If onlyTag is specified, only prune that group
  // If onlyTag is undefined, prune all groups
  const targetGroups: [string | null, string[]][] =
    onlyTag !== undefined ? [[onlyTag, groups.get(onlyTag) || []]] : [...groups.entries()];

  let totalRemoved = 0;
  for (const [_, groupVersions] of targetGroups) {
    const sorted = groupVersions.toSorted((a, b) => extractTimestamp(b) - extractTimestamp(a));
    if (sorted.length <= config.prune_keep) {
      continue;
    }

    const toRemove = sorted.slice(config.prune_keep).filter(v => !referenced.has(v));

    if (toRemove.length === 0) {
      continue;
    }

    const { removed, failed } = await unpublishVersions(config, pkgName, toRemove);
    for (const v of removed) {
      log.dim(`  Pruned ${pkgName}@${v}`);
    }
    for (const v of failed) {
      log.warn(`  Failed to prune ${pkgName}@${v}`);
    }
    totalRemoved += removed.length;
  }

  return totalRemoved;
}

export async function pruneAll(config: pkglabConfig, onlyTag?: string | null): Promise<number> {
  const activeRepos = await getActiveRepos();
  const referenced = new Set<string>();
  for (const { state } of activeRepos) {
    for (const link of Object.values(state.packages)) {
      referenced.add(link.current);
    }
  }

  const packages = await listAllPackages();
  const toPrune = packages.filter(pkg => pkg.versions.filter(ispkglabVersion).length > 0);

  const results = await Promise.all(
    toPrune.map(pkg => prunePackage(config, pkg.name, pkg.versions, referenced, onlyTag)),
  );

  return results.reduce((sum, n) => sum + n, 0);
}
