---
"pkglab": minor
---

Automatically prune consumer repos whose directories no longer exist on disk instead of crashing with ENOENT. Any command that accesses saved repos (pub, down, up, doctor, repo ls, etc.) now detects missing directories and removes the stale repo state, logging a warning.
