---
"pkglab": patch
---

Fix race condition where lockfile integrity fetch was cached across consumer repos, causing stale results when an earlier repo triggered the fetch before all packages were published
