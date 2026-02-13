---
"pkglab": minor
---

Add `--scope` and `--tag` flags to `pkglab add`. `--scope clerk` (or `--scope @clerk`) scans the workspace for all dependencies matching `@clerk/*`, verifies they are all published, and replaces them in one command. `--tag feat1` applies a tag to all packages at once (equivalent to the inline `@tag` syntax). Both flags can be combined: `pkglab add --scope clerk --tag feat1`.
