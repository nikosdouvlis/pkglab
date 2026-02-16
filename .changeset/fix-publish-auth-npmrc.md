---
"pkglab": patch
---

Fix publish auth by passing NPM_CONFIG_TOKEN env var to bun publish instead of writing .npmrc files. The previous approach used unsupported npm_config env vars, causing "missing authentication" errors in CI.
