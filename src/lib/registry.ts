import type { pkglabConfig } from "../types";
import { npmEnvWithAuth } from "./publisher";

function registryUrl(config: pkglabConfig): string {
  return `http://127.0.0.1:${config.port}`;
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

export async function unpublishVersion(
  config: pkglabConfig,
  name: string,
  version: string,
): Promise<void> {
  const url = registryUrl(config);
  const proc = Bun.spawn(
    ["npm", "unpublish", `${name}@${version}`, "--registry", url, "--force"],
    { stdout: "pipe", stderr: "pipe", env: npmEnvWithAuth(url) },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Unpublish failed for ${name}@${version}: ${stderr}`);
  }
}
