---
"pkglab": patch
---

Fix daemon health check failing on Linux by adding HTTP ping fallback when `ps` date parsing fails. Bun uses JavaScriptCore which may not parse `ps -o lstart=` output on all platforms.
