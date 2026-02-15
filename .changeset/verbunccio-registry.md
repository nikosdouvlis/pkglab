---
"pkglab": minor
---

Replace Verdaccio with a lightweight Bun.serve() registry server (Verbunccio) as the default backend. The new registry holds package metadata in memory with write-through persistence to disk, proxies unknown packages to npmjs.org, and merges local versions with upstream packuments so non-pkglab versions still resolve correctly.

Key improvements over Verdaccio: 6x faster cold start (59ms vs 335ms), 3x faster parallel publish for 22 packages (1.06s vs 3.5s), sub-millisecond packument lookups from memory, and 66% lower memory usage (44MB vs 128MB idle).

The legacy Verdaccio backend is still available via PKGLAB_VERDACCIO=1.
