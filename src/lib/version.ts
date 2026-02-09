const VERSION_PREFIX = "0.0.0-pkgl.";
let lastTimestamp = 0;

export function generateVersion(): string {
  const now = Date.now();
  const ts = Math.max(lastTimestamp + 1, now);
  lastTimestamp = ts;
  return `${VERSION_PREFIX}${ts}`;
}

export function isPkglVersion(version: string): boolean {
  return version.startsWith(VERSION_PREFIX);
}

export function extractTimestamp(version: string): number {
  return parseInt(version.slice(VERSION_PREFIX.length), 10);
}

export function seedTimestamp(existingVersions: string[]): void {
  for (const v of existingVersions) {
    if (isPkglVersion(v)) {
      const ts = extractTimestamp(v);
      if (ts > lastTimestamp) lastTimestamp = ts;
    }
  }
}
