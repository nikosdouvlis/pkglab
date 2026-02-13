# pkglab

## 0.2.0

### Minor Changes

- 1880a68: Auto-detect catalog entries when adding packages: pkglab add now checks if a package exists in a workspace catalog and automatically uses catalog mode, removing the need for the --catalog flag in most cases
- d5d1454: Unify consumer install path: upsert packages into package.json and always use `pm install` instead of branching between `pm add` and `pm install`
- 5274336: Auto-detect workspace sub-packages when adding packages: `pkglab add` now scans all workspace packages for the dependency and updates all of them. Use `-p` to opt out and target a single sub-package. Restore handles multi-target. Internal state format changed to use a targets array per package.
- 10f875e: Add pnpm catalog support: `--catalog` flag now works with pnpm workspaces that define catalogs in pnpm-workspace.yaml, in addition to bun/npm catalogs in package.json
- ff261a9: Add `--scope` and `--tag` flags to `pkglab add`. `--scope clerk` (or `--scope @clerk`) scans the workspace for all dependencies matching `@clerk/*`, verifies they are all published, and replaces them in one command. `--tag feat1` applies a tag to all packages at once (equivalent to the inline `@tag` syntax). Both flags can be combined: `pkglab add --scope clerk --tag feat1`.

### Patch Changes

- 8d6e166: Add E2E tests for nested package install (-p flag) and bun catalog support (--catalog flag)

## 0.1.1

### Patch Changes

- f5ef3f0: Fix npm publish failing on npm 11 by adding required --tag flag for prerelease versions

## 0.1.0

### Minor Changes

- c75f655: Identify consumer repos by filesystem path instead of package.json name. Repo state files now use a deterministic hash-based filename derived from the path, so renaming a package.json no longer orphans the repo. Display names are read from package.json at runtime. Existing repo files are auto-migrated on first use. The `repo rename` command has been removed since there is no stored name to rename.

### Patch Changes

- 7a13feb: Fix crash on machines without bun in PATH. The prune subprocess was spawning `bun` directly, which fails on systems that only have the compiled binary. Now uses `process.execPath` with a hidden `--__prune` flag, matching the existing daemon pattern.
