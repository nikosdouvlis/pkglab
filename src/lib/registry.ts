import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { paths } from "./paths";
import { ispkglabVersion } from "./version";
import type { pkglabConfig } from "../types";

function registryUrl(config: pkglabConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

function storagePath(pkgName: string): string {
  return join(paths.verdaccioStorage, pkgName);
}

function unscopedName(pkgName: string): string {
  const slash = pkgName.lastIndexOf("/");
  return slash === -1 ? pkgName : pkgName.slice(slash + 1);
}

export async function getPkglabVersions(
  pkgName: string,
): Promise<string[]> {
  const dir = storagePath(pkgName);
  const prefix = unscopedName(pkgName) + "-";
  try {
    const files = await readdir(dir);
    const versions: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".tgz") || !f.startsWith(prefix)) continue;
      const version = f.slice(prefix.length, -4);
      if (ispkglabVersion(version)) versions.push(version);
    }
    return versions;
  } catch {
    return [];
  }
}

export async function listPkglabPackages(): Promise<
  Array<{ name: string; versions: string[] }>
> {
  const results: Array<{ name: string; versions: string[] }> = [];
  try {
    const entries = await readdir(paths.verdaccioStorage, {
      withFileTypes: true,
    });
    const dirs: { name: string; path: string }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        // Scoped package: read subdirectories
        const scopeDir = join(paths.verdaccioStorage, entry.name);
        const scopeEntries = await readdir(scopeDir, { withFileTypes: true });
        for (const sub of scopeEntries) {
          if (sub.isDirectory()) {
            dirs.push({
              name: `${entry.name}/${sub.name}`,
              path: join(scopeDir, sub.name),
            });
          }
        }
      } else {
        dirs.push({
          name: entry.name,
          path: join(paths.verdaccioStorage, entry.name),
        });
      }
    }

    const resolved = await Promise.all(
      dirs.map(async (d) => ({
        name: d.name,
        versions: await getPkglabVersions(d.name),
      })),
    );
    for (const r of resolved) {
      if (r.versions.length > 0) results.push(r);
    }
  } catch {}
  return results;
}

export async function getPackageVersions(
  config: pkglabConfig,
  name: string,
): Promise<string[]> {
  try {
    const url = `${registryUrl(config)}/${encodeURIComponent(name)}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    return Object.keys(data.versions || {});
  } catch {
    return [];
  }
}

export async function listPackageNames(
  config: pkglabConfig,
): Promise<string[]> {
  try {
    const resp = await fetch(
      `${registryUrl(config)}/-/verdaccio/data/packages`,
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    return data.map((pkg: any) => pkg.name as string);
  } catch {
    return [];
  }
}

export async function listAllPackages(
  config: pkglabConfig,
): Promise<Array<{ name: string; versions: string[] }>> {
  try {
    const resp = await fetch(
      `${registryUrl(config)}/-/verdaccio/data/packages`,
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    const names = data.map((pkg: any) => pkg.name as string);

    // Fetch full version lists in parallel
    const results = await Promise.all(
      names.map(async (name) => ({
        name,
        versions: await getPackageVersions(config, name),
      })),
    );
    return results;
  } catch {
    return [];
  }
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
