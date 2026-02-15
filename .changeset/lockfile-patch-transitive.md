---
"pkglab": patch
---

Fix lockfile patching for pnpm consumers with transitive pkglab dependencies. Previously, integrity hashes were only updated for directly tracked packages, causing ERR_PNPM_TARBALL_INTEGRITY errors when the lockfile also contained pkglab packages pulled in as transitive dependencies. Now builds patch entries from all published packages so every pkglab package in the lockfile gets its integrity hash updated.
