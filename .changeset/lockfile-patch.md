---
"pkglab": minor
---

Patch pnpm lockfiles directly to skip resolution during consumer updates. For pnpm consumers, pkglab now replaces version strings and integrity hashes in pnpm-lock.yaml, then runs `pnpm install --frozen-lockfile` to skip the expensive dependency resolution phase. Falls back to regular install if patching fails. Only affects pnpm consumers.
