---
"pkglab": minor
---

Replace Unix socket IPC with HTTP endpoint on registry server. Publish coalescing now runs inside the Verbunccio process via POST /-/pkglab/publish. The listen command shows a deprecation notice and queue status. Old listener files kept for now.
