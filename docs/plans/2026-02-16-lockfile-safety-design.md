# Lockfile Safety: Preventing Localhost URL Leaks

Date: 2026-02-16

## Problem

When pkglab is active, `bun install` resolves ALL packages through the local Verdaccio/Verbunccio proxy at `127.0.0.1:{port}`. Bun records the full resolved URL per-package in `bun.lock`. If that lockfile gets committed, CI environments hang trying to connect to localhost.

This broke Drivepoint CI: 1,470 out of ~1,600 packages had `http://127.0.0.1:16180/...` URLs baked into `bun.lock`. The `chore: deps update` commit was run while pkglab was active. CI's `bun install` hung for 10 minutes trying to reach localhost, then timed out.

Root cause: bun's lockfile format embeds registry URLs per-package (unlike pnpm which resolves at install time). The global `.npmrc` registry redirect contaminates every entry.

## Changes

## 1. Extend `pkglab check` to scan lockfiles

`src/commands/check.ts` already scans staged `.npmrc` and `package.json` for pkglab artifacts. Add lockfile scanning.

New checks:
- Staged `bun.lock` or `bun.lockb` containing `127.0.0.1` or `localhost` URLs
- Staged `pnpm-lock.yaml` containing `127.0.0.1` or `localhost` URLs (same principle)

Use `git show :bun.lock` to read the staged version (same pattern as the existing package.json check). Check for the pattern `"http://127.0.0.1:` or `"http://localhost:` in the staged content.

Exit code 1 if any localhost URLs found, with a message like:
```
  x Staged bun.lock contains 1,470 localhost registry URLs
    Run: pkglab doctor --lockfile
```

## 2. Auto-inject pre-commit hook

On first `pkglab add` to a repo, inject `pkglab check` into the consumer's pre-commit hook.

Detection order:
1. Husky: look for `.husky/pre-commit` (husky v9 uses `core.hooksPath=.husky`)
2. Lefthook: look for `.lefthook/pre-commit/` or `lefthook.yml`
3. Raw git: fall back to `.git/hooks/pre-commit`

Injection: append a marker block (same pattern as `.npmrc`):
```sh
# pkglab-start
lclpkgl check
# pkglab-end
```

Removal: strip the marker block on `pkglab restore --all` or `pkglab down` (when no packages remain for that repo).

Do NOT use `skip-worktree` for hook files. The hook addition is benign (exits 0 when clean), so accidental commits are harmless. Marker removal on restore is sufficient.

## 3. Make `pkglab down` transactional

Current `down.ts` stops the daemon without considering consumer repo state. Repos with pkglab versions and .npmrc redirects break silently.

New default behavior:
1. Walk all repos with active pkglab packages (from saved repo state)
2. Run `pkglab restore --all` for each
3. Clean .npmrc and pre-commit hook markers
4. Stop the daemon

If any restore fails, report the error and do NOT stop the daemon. The user must fix the issue first or use `--force`.

Add `--force` flag: stop daemon immediately without restoring. For cases where the user knows what they're doing.

## 4. Extend `pkglab doctor` for dirty state recovery

Fold repair functionality into the existing `doctor` command instead of adding a separate command. `doctor` already detects and auto-repairs `.npmrc` and `skip-worktree` issues.

New capabilities:
- Detect dirty state: daemon not running but repos have active pkglab packages
- When dirty state found, suggest `pkglab restore --all` to recover
- `--lockfile` flag: sanitize `bun.lock` by replacing localhost URLs with `""` (empty string, bun interprets as default registry)
- Auto-trigger dirty state detection on `pkglab up` / `pkglab status` / `pkglab check` as well

This keeps one diagnostic/repair command instead of two. `doctor` diagnoses and fixes environment issues, `restore` handles version rollback.

## 5. Lockfile sanitizer (convenience, not safety)

After pkglab-managed `bun install` calls (in `installWithVersionUpdates`), post-process `bun.lock` to replace localhost tarball URLs with `""`.

In bun.lock format, each package is a tuple:
```
["@pkg/name@1.0.0", "http://127.0.0.1:16180/@pkg/name/-/name-1.0.0.tgz", { deps }, "sha512-..."]
```

Replace the second element with `""` for any entry containing `127.0.0.1` or `localhost`. Bun interprets `""` as "use the currently configured registry."

This reduces accidental poisoning but cannot catch manual `bun install` runs, which is why the pre-commit hook is the primary defense.

## Implementation order

1. `pkglab check` lockfile scanning (closes the detection gap)
2. Pre-commit hook injection/removal (auto-setup)
3. `pkglab down` transactional behavior (lifecycle fix)
4. `pkglab doctor` dirty state detection + `--lockfile` sanitizer (recovery)
5. Lockfile sanitizer in `installWithVersionUpdates` (convenience)

Items 1-2 are the minimum to prevent a repeat of the CI break. Items 3-5 improve the overall lifecycle management.
