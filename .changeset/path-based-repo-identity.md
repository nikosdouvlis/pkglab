---
"pkglab": minor
---

Identify consumer repos by filesystem path instead of package.json name. Repo state files now use a deterministic hash-based filename derived from the path, so renaming a package.json no longer orphans the repo. Display names are read from package.json at runtime. Existing repo files are auto-migrated on first use. The `repo rename` command has been removed since there is no stored name to rename.
