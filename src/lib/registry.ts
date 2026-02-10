import type { pkglabConfig } from "../types";
import { run, npmEnvWithAuth } from "./proc";

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
  const result = await run(
    ["npm", "unpublish", `${name}@${version}`, "--registry", url, "--force"],
    { env: npmEnvWithAuth(url) },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Unpublish failed for ${name}@${version}: ${result.stderr}`);
  }
}
