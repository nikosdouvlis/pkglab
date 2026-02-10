import { join } from "node:path";
import { paths } from "./paths";
import { log } from "./log";
import { c } from "./color";

const CHECK_FILE = join(paths.home, "update-check.json");
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 1 day

interface CheckCache {
  lastCheck: number;
  latestVersion: string;
}

async function readCache(): Promise<CheckCache | null> {
  const file = Bun.file(CHECK_FILE);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as CheckCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: CheckCache): Promise<void> {
  await Bun.write(CHECK_FILE, JSON.stringify(cache));
}

async function getCurrentVersion(): Promise<string | null> {
  try {
    const pkgPath = join(import.meta.dir, "../../package.json");
    const pkg = await Bun.file(pkgPath).json();
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/pkglab/latest", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(): Promise<void> {
  try {
    const current = await getCurrentVersion();
    if (!current) return;

    const cache = await readCache();
    const now = Date.now();

    let latest: string | null = null;

    if (cache && now - cache.lastCheck < CHECK_INTERVAL) {
      latest = cache.latestVersion;
    } else {
      latest = await fetchLatestVersion();
      if (latest) {
        await writeCache({ lastCheck: now, latestVersion: latest });
      }
    }

    if (!latest || latest === current) return;

    log.line("");
    log.line(
      `  ${c.yellow("Update available")} ${c.dim(current)} → ${c.green(latest)}`,
    );
    log.line(`  Run ${c.cyan("bun install -g pkglab")} to update`);
    log.line("");
  } catch {
    // never block startup
  }
}
