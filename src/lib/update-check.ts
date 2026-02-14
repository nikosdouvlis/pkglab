import { join } from "node:path";
import { paths } from "./paths";
import { log } from "./log";
import { c } from "./color";
import { getVersion } from "./version";

const CHECK_FILE = join(paths.home, "update-check.json");

async function writeCache(latest: string): Promise<void> {
  await Bun.write(CHECK_FILE, JSON.stringify({ latestVersion: latest }));
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

// Call early so the fetch runs in the background while the user interacts.
export async function prefetchUpdateCheck(): Promise<() => Promise<void>> {
  const current = await getVersion();
  if (current === "0.0.0") return async () => {};

  // Kick off fetch immediately so it runs in the background
  const fetchPromise = fetchLatestVersion();

  return async () => {
    try {
      const latest = await fetchPromise;
      if (latest) {
        await writeCache(latest);
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

