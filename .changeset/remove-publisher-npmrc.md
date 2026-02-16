---
"pkglab": patch
---

Stop writing .npmrc to publisher workspace root during pub. Auth token is now passed via env var to bun publish instead of creating/restoring a temporary .npmrc file.
