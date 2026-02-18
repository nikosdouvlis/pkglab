---
"pkglab": patch
---

Fix install failing when pkglab runs inside a pnpm script chain. pnpm injects `npm_config_registry` into child processes, which overrides the `.npmrc` that pkglab writes. The install subprocess now explicitly sets `npm_config_registry` to the local registry URL.
