---
"pkglab": minor
---

Lockfile safety: prevent localhost registry URLs from leaking into commits

- `pkglab check` now scans staged lockfiles (bun.lock, bun.lockb, pnpm-lock.yaml) for localhost registry URLs
- `pkglab add` auto-injects `pkglab check` into pre-commit hooks (Husky, raw git), removed on restore
- `pkglab down` restores all consumer repos before stopping the daemon, use `--force` to skip
- `pkglab doctor` detects dirty state and gains `--lockfile` flag to sanitize bun.lock files
- After pkglab-managed bun installs, bun.lock is post-processed to strip localhost URLs
