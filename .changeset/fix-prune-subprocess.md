---
"pkglab": patch
---

Fix crash on machines without bun in PATH. The prune subprocess was spawning `bun` directly, which fails on systems that only have the compiled binary. Now uses `process.execPath` with a hidden `--__prune` flag, matching the existing daemon pattern.
