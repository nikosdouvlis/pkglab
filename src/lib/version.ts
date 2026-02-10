const VERSION_PREFIX = "0.0.0-pkglab.";
let lastTimestamp = 0;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function generateVersion(): string {
  const now = Date.now();
  const ts = Math.max(lastTimestamp + 1, now);
  lastTimestamp = ts;

  const d = new Date(ts);
  const date = `${d.getFullYear() % 100}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

  return `${VERSION_PREFIX}${date}--${time}.${ts}`;
}

export function ispkglabVersion(version: string): boolean {
  return version.startsWith(VERSION_PREFIX);
}

export function extractTimestamp(version: string): number {
  const suffix = version.slice(VERSION_PREFIX.length);
  const lastDot = suffix.lastIndexOf(".");
  return parseInt(lastDot >= 0 ? suffix.slice(lastDot + 1) : suffix, 10);
}
