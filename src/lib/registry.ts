import type { PkglConfig } from "../types";

function registryUrl(config: PkglConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

export async function getPackageVersions(
  config: PkglConfig,
  name: string
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
  config: PkglConfig
): Promise<Array<{ name: string; versions: string[] }>> {
  try {
    const resp = await fetch(`${registryUrl(config)}/-/verdaccio/packages`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    return data.map((pkg: any) => ({
      name: pkg.name,
      versions: Object.keys(pkg.versions || {}),
    }));
  } catch {
    return [];
  }
}

export async function unpublishVersion(
  config: PkglConfig,
  name: string,
  version: string
): Promise<void> {
  const proc = Bun.spawn(
    ["npm", "unpublish", `${name}@${version}`, "--registry", registryUrl(config), "--force"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Unpublish failed for ${name}@${version}: ${stderr}`);
  }
}
