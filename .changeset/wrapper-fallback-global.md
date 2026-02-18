---
"pkglab": patch
---

Fix wrapper shim failing when pnpm skips optionalDependencies. The bin wrapper now falls back to a global `pkglab` binary in PATH when the platform-specific package is missing, instead of erroring immediately.
