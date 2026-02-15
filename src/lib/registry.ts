import { readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import type { pkglabConfig } from '../types';

import { paths } from './paths';
import { ispkglabVersion } from './version';

export function registryUrl(config: pkglabConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

// ---------------------------------------------------------------------------
// Verbunccio HTTP index helpers
// ---------------------------------------------------------------------------

let resolvedBackend: 'verbunccio' | 'verdaccio' | null = null;

async function resolveBackend(): Promise<'verbunccio' | 'verdaccio'> {
  if (resolvedBackend) return resolvedBackend;
  let result: 'verbunccio' | 'verdaccio' = process.env.PKGLAB_VERDACCIO === '1' ? 'verdaccio' : 'verbunccio';
  try {
    const pidFile = Bun.file(paths.pid);
    if (await pidFile.exists()) {
      const data = JSON.parse(await pidFile.text());
      if (data.backend === 'verbunccio' || data.backend === 'verdaccio') {
        result = data.backend;
      }
    }
  } catch {
    // Fall through to env var default
  }
  resolvedBackend = result;
  return result;
}

async function isVerbunccio(): Promise<boolean> {
  return (await resolveBackend()) === 'verbunccio';
}

export function resetBackendCache(): void {
  resolvedBackend = null;
}

let cachedIndex: { packages: Record<string, { rev: string; 'dist-tags': Record<string, string>; versions: string[] }> } | null = null;

async function fetchIndex(config: pkglabConfig): Promise<typeof cachedIndex> {
  if (cachedIndex) return cachedIndex;
  const resp = await fetch(`${registryUrl(config)}/-/pkglab/index`);
  if (!resp.ok) throw new Error(`Failed to fetch index: ${resp.status}`);
  cachedIndex = await resp.json();
  return cachedIndex;
}

export function invalidateIndexCache(): void {
  cachedIndex = null;
}

// ---------------------------------------------------------------------------
// Storage-based reads (no HTTP, no upstream proxy contamination)
// ---------------------------------------------------------------------------

async function scanStoragePackages(): Promise<string[]> {
  const storageDir = paths.registryStorage;
  const names: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(storageDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue;
    }

    if (entry.startsWith('@')) {
      // Scoped packages: @scope/name
      try {
        const scopeEntries = await readdir(join(storageDir, entry));
        for (const pkg of scopeEntries) {
          if (!pkg.startsWith('.')) {
            names.push(`${entry}/${pkg}`);
          }
        }
      } catch {
        continue;
      }
    } else {
      names.push(entry);
    }
  }

  return names;
}

async function readStoragePackageJson(name: string): Promise<Record<string, any> | null> {
  const pkgJsonPath = join(paths.registryStorage, name, 'package.json');
  try {
    return await Bun.file(pkgJsonPath).json();
  } catch {
    return null;
  }
}

export async function listPackageNames(config?: pkglabConfig): Promise<string[]> {
  if (await isVerbunccio() && config) {
    const index = await fetchIndex(config);
    return Object.keys(index!.packages);
  }

  const allNames = await scanStoragePackages();
  const result: string[] = [];

  for (const name of allNames) {
    // Check for pkglab tarballs without parsing JSON
    const dir = join(paths.registryStorage, name);
    try {
      const files = await readdir(dir);
      if (files.some(f => f.includes('pkglab') && f.endsWith('.tgz'))) {
        result.push(name);
      }
    } catch {
      continue;
    }
  }

  return result;
}

export async function listAllPackages(config?: pkglabConfig): Promise<Array<{ name: string; versions: string[] }>> {
  if (await isVerbunccio() && config) {
    const index = await fetchIndex(config);
    return Object.entries(index!.packages).map(([name, data]) => ({
      name,
      versions: data.versions,
    }));
  }

  const allNames = await scanStoragePackages();
  const results: Array<{ name: string; versions: string[] }> = [];

  for (const name of allNames) {
    const doc = await readStoragePackageJson(name);
    if (!doc?.versions) {
      continue;
    }

    const versions = Object.keys(doc.versions).filter(ispkglabVersion);
    if (versions.length > 0) {
      results.push({ name, versions });
    }
  }

  return results;
}

export async function getDistTags(name: string, config?: pkglabConfig): Promise<Record<string, string>> {
  if (await isVerbunccio() && config) {
    const index = await fetchIndex(config);
    const pkg = index!.packages[name];
    if (!pkg?.['dist-tags']) return {};
    return { ...pkg['dist-tags'] };
  }

  const doc = await readStoragePackageJson(name);
  if (!doc?.['dist-tags']) {
    return {};
  }

  const tags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(doc['dist-tags'])) {
    if (ispkglabVersion(version as string)) {
      tags[tag] = version as string;
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// HTTP-based mutations (go through Verdaccio API)
// ---------------------------------------------------------------------------

export async function setDistTag(config: pkglabConfig, name: string, version: string, tag: string): Promise<void> {
  const url = `${registryUrl(config)}/-/package/${encodeURIComponent(name)}/dist-tags/${encodeURIComponent(tag)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer pkglab-local',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(version),
  });
  if (!resp.ok) {
    throw new Error(`Failed to set dist-tag ${tag} on ${name}: ${resp.status}`);
  }
  invalidateIndexCache();
}

export async function unpublishVersions(
  config: pkglabConfig,
  name: string,
  versions: string[],
): Promise<{ removed: string[]; failed: string[] }> {
  if (versions.length === 0) {
    return { removed: [], failed: [] };
  }

  const url = registryUrl(config);
  const pkgUrl = `${url}/${encodeURIComponent(name)}`;
  const headers = { Authorization: 'Bearer pkglab-local' };

  const resp = await fetch(pkgUrl, { headers });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${name}: ${resp.status}`);
  }

  const doc = await resp.json();
  const removeSet = new Set(versions);
  const removed: string[] = [];

  for (const v of versions) {
    if (!doc.versions?.[v]) {
      continue;
    }
    delete doc.versions[v];
    if (doc.time) {
      delete doc.time[v];
    }
    removed.push(v);
  }

  // Clean up dist-tags pointing to removed versions
  if (doc['dist-tags']) {
    for (const [tag, v] of Object.entries(doc['dist-tags'])) {
      if (removeSet.has(v as string)) {
        delete doc['dist-tags'][tag];
      }
    }
  }

  if (removed.length === 0) {
    return { removed: [], failed: [] };
  }

  const rev = doc._rev || '0-0';
  let putResp = await fetch(`${pkgUrl}/-rev/${rev}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });

  // Retry on 409 conflict (revision mismatch, common with Verbunccio)
  const MAX_RETRIES = 3;
  for (let retry = 0; !putResp.ok && putResp.status === 409 && retry < MAX_RETRIES; retry++) {
    invalidateIndexCache();
    // Refetch latest doc
    const refetchResp = await fetch(pkgUrl, { headers });
    if (!refetchResp.ok) break;
    const freshDoc = await refetchResp.json();
    // Reapply mutations
    const freshRemoved: string[] = [];
    for (const v of versions) {
      if (!freshDoc.versions?.[v]) continue;
      delete freshDoc.versions[v];
      if (freshDoc.time) delete freshDoc.time[v];
      freshRemoved.push(v);
    }
    if (freshDoc['dist-tags']) {
      for (const [tag, v] of Object.entries(freshDoc['dist-tags'])) {
        if (removeSet.has(v as string)) delete freshDoc['dist-tags'][tag];
      }
    }
    if (freshRemoved.length === 0) break;
    const freshRev = freshDoc._rev || '0-0';
    putResp = await fetch(`${pkgUrl}/-rev/${freshRev}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(freshDoc),
    });
    if (putResp.ok) {
      removed.length = 0;
      removed.push(...freshRemoved);
    }
  }

  if (!putResp.ok) {
    return { removed: [], failed: versions };
  }

  invalidateIndexCache();
  return { removed, failed: versions.filter(v => !removed.includes(v)) };
}

export async function removePackage(config: pkglabConfig, name: string): Promise<boolean> {
  const url = registryUrl(config);
  const pkgUrl = `${url}/${encodeURIComponent(name)}`;
  const headers = { Authorization: 'Bearer pkglab-local' };

  // Get the revision needed for DELETE
  const resp = await fetch(pkgUrl, { headers });
  if (!resp.ok) {
    return false;
  }
  const doc = await resp.json();
  const rev = doc._rev || '0-0';

  // Delete from registry API
  const delResp = await fetch(`${pkgUrl}/-rev/${rev}`, {
    method: 'DELETE',
    headers,
  });
  invalidateIndexCache();

  if (!(await isVerbunccio())) {
    // Clean up storage directory (Verdaccio may not fully clean up)
    const pkgDir = join(paths.registryStorage, name);
    await rm(pkgDir, { recursive: true, force: true }).catch(() => {});

    // Clean up empty scope directory
    if (name.startsWith('@')) {
      const scopeDir = dirname(pkgDir);
      try {
        const remaining = await readdir(scopeDir);
        if (remaining.length === 0) {
          await rm(scopeDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }

  return delResp.ok;
}
