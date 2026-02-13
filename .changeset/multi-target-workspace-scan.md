---
"pkglab": minor
---

Auto-detect workspace sub-packages when adding packages: `pkglab add` now scans all workspace packages for the dependency and updates all of them. Use `-p` to opt out and target a single sub-package. Restore handles multi-target. Internal state format changed to use a targets array per package.
