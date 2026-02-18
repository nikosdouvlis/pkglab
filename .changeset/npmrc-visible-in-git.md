---
"pkglab": minor
---

Stop hiding .npmrc with skip-worktree so it appears in git status. Pre-commit check now only errors if .npmrc with pkglab markers is actually staged, not just present on disk.
