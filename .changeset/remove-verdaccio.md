---
"pkglab": minor
---

Remove Verdaccio dependency and use the built-in registry server exclusively. Storage directory migrates automatically from `~/.pkglab/verdaccio/` to `~/.pkglab/registry/`. Drops `verdaccio` and `libnpmpublish` from dependencies.
