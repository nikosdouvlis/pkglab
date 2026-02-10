import { log } from "./log";
import { pkglabError } from "./errors";

const PKGLAB_BASE = "0.0.0-pkglab";

let lastTimestamp = 0;

export function generateVersion(tag?: string): string {
  const now = Date.now();
  const ts = Math.max(lastTimestamp + 1, now);
  lastTimestamp = ts;

  if (tag) {
    return `${PKGLAB_BASE}-${tag}.${ts}`;
  }
  return `${PKGLAB_BASE}.${ts}`;
}

export function ispkglabVersion(version: string): boolean {
  if (!version.startsWith(PKGLAB_BASE)) return false;
  const next = version[PKGLAB_BASE.length];
  return next === "." || next === "-";
}

export function extractTimestamp(version: string): number {
  const lastDot = version.lastIndexOf(".");
  if (lastDot < 0) return NaN;
  return parseInt(version.slice(lastDot + 1), 10);
}

export function extractTag(version: string): string | null {
  if (!ispkglabVersion(version)) return null;
  const next = version[PKGLAB_BASE.length];
  if (next !== "-") return null;
  const rest = version.slice(PKGLAB_BASE.length + 1);
  const lastDot = rest.lastIndexOf(".");
  if (lastDot < 0) return null;
  return rest.slice(0, lastDot);
}

export function sanitizeTag(raw: string): string {
  let tag = raw.replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "");
  tag = tag.replace(/-{2,}/g, "-");
  tag = tag.replace(/^-+|-+$/g, "");

  if (tag.length > 50) {
    log.warn(`Tag "${raw}" truncated to 50 characters`);
    tag = tag.slice(0, 50).replace(/-+$/, "");
  }

  if (!tag) {
    throw new pkglabError(`Tag "${raw}" is empty after sanitization`);
  }

  return tag;
}
