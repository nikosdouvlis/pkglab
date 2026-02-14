---
"pkglab": patch
---

Performance optimizations: stream file hashing instead of loading into memory, precompute graph transitive closures, fingerprint all packages upfront in one batch, cache workspace discovery in add --scope. Also adds a "Published N packages in X.XXs" timing log to pub output.
