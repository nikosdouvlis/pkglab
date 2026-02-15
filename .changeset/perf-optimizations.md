---
"pkglab": minor
---

Performance optimizations for pub command: mtime-gated fingerprinting skips content hashing when files are unchanged, graph pass-through eliminates redundant dependency graph rebuilds, per-phase timing instrumentation (visible with --verbose), and --prefer-offline for pnpm/bun consumer installs.
