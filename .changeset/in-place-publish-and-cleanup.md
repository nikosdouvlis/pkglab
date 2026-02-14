---
"pkglab": minor
---

Publish packages in-place instead of copying to a temp directory, reducing publish time for all Clerk packages from ~11s to ~1s. Original package.json is renamed to package.json.pkglab during publish and restored in a finally block. If a crash interrupts the restore, the next pub auto-recovers and doctor detects leftovers.

Also: switch config and repo state from YAML to JSON, add --scope/--tag/--dry-run/--verbose flags to restore, add --all to repo on/off, shared arg utilities, dead code removal, and various CLI consistency fixes.
