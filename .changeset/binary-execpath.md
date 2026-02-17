---
"pkglab": patch
---

Use process.execPath instead of hardcoded 'bun' for subprocess spawning, so the compiled binary works on systems without Bun installed.
