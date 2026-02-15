---
"pkglab": patch
---

Skip lifecycle scripts during consumer installs for faster updates. All package managers now use `--ignore-scripts` by default, with automatic fallback to a full install if it fails.
