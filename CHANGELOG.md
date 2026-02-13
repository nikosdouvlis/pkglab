# pkglab

## 0.2.0

### Minor Changes

- d5d1454: Unify consumer install path: upsert packages into package.json and always use `pm install` instead of branching between `pm add` and `pm install`
- 10f875e: Add pnpm catalog support: `--catalog` flag now works with pnpm workspaces that define catalogs in pnpm-workspace.yaml, in addition to bun/npm catalogs in package.json

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
