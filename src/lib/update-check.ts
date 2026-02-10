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

declare const __PKGLAB_VERSION__: string | undefined;

async function getCurrentVersion(): Promise<string | null> {
  try {
    const pkgPath = join(import.meta.dir, "../../package.json");
    const pkg = await Bun.file(pkgPath).json();
    return pkg.version ?? null;
  } catch {
    return typeof __PKGLAB_VERSION__ !== "undefined" ? __PKGLAB_VERSION__ : null;
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

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

// Resolve the latest version (from cache or network).
// Call early so the fetch runs in the background while the user interacts.
export async function prefetchUpdateCheck(): Promise<() => Promise<void>> {
  const current = await getCurrentVersion();
  if (!current) return async () => {};

  const cache = await readCache();
  const now = Date.now();

  // Cache hit: no network needed, return sync display
  if (cache && now - cache.lastCheck < CHECK_INTERVAL) {
    return async () => {
      if (cache.latestVersion && isNewer(cache.latestVersion, current)) {
        printBanner(current, cache.latestVersion);
      }
    };
  }

  // Cache miss: kick off fetch, return a function that awaits it
  const fetchPromise = fetchLatestVersion();

  return async () => {
    try {
      const latest = await fetchPromise;
      if (latest) {
        await writeCache({ lastCheck: now, latestVersion: latest });
        if (isNewer(latest, current)) {
          printBanner(current, latest);
        }
      }
    } catch {
      // never block exit
    }
  };
}

function printBanner(current: string, latest: string): void {
  log.line("");
  log.line(
    `  ${c.yellow("Update available")} ${c.dim(current)} → ${c.green(latest)}`,
  );
  log.line(`  Run ${c.cyan("bun install -g pkglab")} to update`);
  log.line("");
}

// Legacy one-shot for callers that don't need the prefetch pattern
export async function checkForUpdate(): Promise<void> {
  try {
    const showUpdate = await prefetchUpdateCheck();
    await showUpdate();
  } catch {
    // never block startup
  }
}
