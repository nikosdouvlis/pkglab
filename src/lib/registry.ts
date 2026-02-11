import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { pkglabConfig } from "../types";
import { paths } from "./paths";
import { ispkglabVersion } from "./version";

function registryUrl(config: pkglabConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

// ---------------------------------------------------------------------------
// Storage-based reads (no HTTP, no upstream proxy contamination)
// ---------------------------------------------------------------------------

async function scanStoragePackages(): Promise<string[]> {
  const storageDir = paths.verdaccioStorage;
  const names: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(storageDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;

    if (entry.startsWith("@")) {
      // Scoped packages: @scope/name
      try {
        const scopeEntries = await readdir(join(storageDir, entry));
        for (const pkg of scopeEntries) {
          if (!pkg.startsWith(".")) names.push(`${entry}/${pkg}`);
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

async function readStoragePackageJson(
  name: string,
): Promise<Record<string, any> | null> {
  const pkgJsonPath = join(paths.verdaccioStorage, name, "package.json");
  try {
    return await Bun.file(pkgJsonPath).json();
  } catch {
    return null;
  }
}

export async function listPackageNames(): Promise<string[]> {
  const allNames = await scanStoragePackages();
  const result: string[] = [];

  for (const name of allNames) {
    // Check for pkglab tarballs without parsing JSON
    const dir = join(paths.verdaccioStorage, name);
    try {
      const files = await readdir(dir);
      if (files.some((f) => f.includes("pkglab") && f.endsWith(".tgz"))) {
        result.push(name);
      }
    } catch {
      continue;
    }
  }

  return result;
}

export async function listAllPackages(): Promise<
  Array<{ name: string; versions: string[] }>
> {
  const allNames = await scanStoragePackages();
  const results: Array<{ name: string; versions: string[] }> = [];

  for (const name of allNames) {
    const doc = await readStoragePackageJson(name);
    if (!doc?.versions) continue;

    const versions = Object.keys(doc.versions).filter(ispkglabVersion);
    if (versions.length > 0) {
      results.push({ name, versions });
    }
  }

  return results;
}

export async function getDistTags(
  name: string,
): Promise<Record<string, string>> {
  const doc = await readStoragePackageJson(name);
  if (!doc?.["dist-tags"]) return {};

  const tags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(doc["dist-tags"])) {
    if (ispkglabVersion(version as string)) {
      tags[tag] = version as string;
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// HTTP-based mutations (go through Verdaccio API)
// ---------------------------------------------------------------------------

export async function setDistTag(
  config: pkglabConfig,
  name: string,
  version: string,
  tag: string,
): Promise<void> {
  const url = `${registryUrl(config)}/-/package/${encodeURIComponent(name)}/dist-tags/${encodeURIComponent(tag)}`;
  await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: "Bearer pkglab-local",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(version),
  });
}

export async function unpublishVersions(
  config: pkglabConfig,
  name: string,
  versions: string[],
): Promise<{ removed: string[]; failed: string[] }> {
  if (versions.length === 0) return { removed: [], failed: [] };

  const url = registryUrl(config);
  const pkgUrl = `${url}/${encodeURIComponent(name)}`;
  const headers = { Authorization: "Bearer pkglab-local" };

  const resp = await fetch(pkgUrl, { headers });
  if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`);

  const doc = (await resp.json()) as any;
  const removeSet = new Set(versions);
  const removed: string[] = [];

  for (const v of versions) {
    if (!doc.versions?.[v]) continue;
    delete doc.versions[v];
    if (doc.time) delete doc.time[v];
    removed.push(v);
  }

  // Clean up dist-tags pointing to removed versions
  if (doc["dist-tags"]) {
    for (const [tag, v] of Object.entries(doc["dist-tags"])) {
      if (removeSet.has(v as string)) {
        delete doc["dist-tags"][tag];
      }
    }
  }

  if (removed.length === 0) return { removed: [], failed: [] };

  const rev = doc._rev || "0-0";
  const putResp = await fetch(`${pkgUrl}/-rev/${rev}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });

  if (!putResp.ok) {
    return { removed: [], failed: versions };
  }

  return { removed, failed: versions.filter((v) => !removed.includes(v)) };
}
