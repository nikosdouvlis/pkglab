<p align="center">
  <img src="docs/img/banner.png" alt="pkglab banner, style inspired by askfeather.ai" />
</p>

Local package development CLI for monorepos. Publish workspace packages to an embedded registry, iterate, and auto-update consumer repos without the headaches of `npm link`, yalc, or manual overrides.

Also available as `pkgl` for short (so efficient ✨).

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Install](#install)
- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Commands](#commands)
- [Multi-worktree support](#multi-worktree-support)
- [Catalog support](#catalog-support)
- [How versioning works](#how-versioning-works)
- [Why not ...](#why-not-)
- [Design decisions](#design-decisions)
- [Configuration](#configuration)
- [Safety](#safety)
- [Acknowledgments](#acknowledgments)

## Features

- Real `npm publish` to a local Verdaccio registry, so you test the same install your users get
- Automatic consumer repo updates after every publish
- Dependency cascade awareness (change a shared util, all dependent packages get republished)
- Content-aware publishing: unchanged packages are skipped automatically, only packages with real changes (or whose deps changed) get a new version
- AI-Agent enabled: multi-worktree tags are supported. Publish from multiple git worktrees in parallel without version conflicts, each worktree gets its own version channel
- Git skip-worktree protection on `.npmrc` so localhost registry URLs don't leak into commits
- Pre-commit safety checks (`pkglab check`) to catch local artifacts before they reach your repo
- Automatic version pruning per tag so the local registry doesn't grow forever
- Works with any consumer package manager: npm, pnpm, yarn, or bun

## Quick start

```bash
# Globally install the binaries
npm install -g pkglab

# Start the local registry
pkglab up

# Publish packaegs from your library monorep
pkglab pub # all (from workspace root), or current (if inside package)
pkglab pub @clerk/backend # specific package and cascade

# From a consumer repo, install a package from the local registry
pkglab add <name> # or omit for interactive prompt

# Make changes to the library, then re-publish
# Active consumer repos update automatically
pkglab pub

# When done, restore original versions
pkglab restore @clerk/backend   # one package
pkglab restore --all            # everything in this repo

# Stop the registry
pkglab down
```

## Install

Prebuilt binaries (no runtime needed):

```
npm install -g pkglab
```

This installs a native binary for your platform. No Bun or Node.js runtime required to run pkglab itself. npm is only used here as a distribution channel.

Under the hood, the `pkglab` npm package contains a tiny Node.js wrapper. It declares platform-specific packages (`pkglab-darwin-arm64`, `pkglab-linux-x64`, etc.) as optional dependencies with `os` and `cpu` constraints, so npm only downloads the one matching your machine. When you run `pkglab`, the wrapper resolves the platform binary and execs it. The compiled binary has the Bun runtime embedded, so nothing else needs to be installed.

Your consumer repos can use any package manager: npm, pnpm, yarn, or bun. pkglab shells out to `npm` for publishing, so Node.js needs to be available on your machine.

Supported on macOS (ARM64, x64) and Linux (x64, ARM64).

## The problem

Testing local package changes across repos is painful. The existing tools all have real problems.

`npm link` creates symlinks into your source directory. React and other libraries that rely on module identity get duplicated: your app loads one copy from `node_modules` and the linked package resolves a second copy from its own `node_modules`. This causes the classic "hooks can only be called inside the body of a function component" crash, broken contexts, and similar issues. A single `npm install` can also silently blow away your links.

`yalc` improves on this by copying files, but it injects `.yalc` directories and modifies `package.json` with `file:` references that behave differently from real registry installs. Lock files end up with local paths instead of registry URLs. The install you test against is structurally different from what your users will get.

`workspace:^` and `workspace:~` protocols only work within a single workspace. If you need to test a package in a separate consumer repo (the common case), they can't help. Even within a workspace, packages resolve to local copies during install rather than going through the registry, which can mask version resolution bugs that only surface in real published installs. There's also a subtler problem: during snapshot or canary releases, `workspace:^` gets resolved to caret ranges like `^3.0.0-snapshot.xxx`. Semver compares pre-release identifiers lexicographically, so a caret range from one release channel can accidentally match versions from a completely different channel. For example, `^3.0.0-canary.v20251211` will match `3.0.0-snapshot.v20251204` because `snapshot` sorts after `canary`, even though that snapshot is older and from a different release channel entirely.

`pnpm overrides` and `yarn resolutions` require editing the consumer's `package.json`, remembering to undo before committing, and don't auto-update when you change the library. When pointed at local or workspace targets, they bypass registry validation, so you can miss broken exports maps, missing files in the `"files"` array, and unresolved `workspace:` / `catalog:` protocols until you actually publish to npm.

**`pkglab`** solves all of this by publishing to a real npm registry running on your machine.

## How it works

**`pkglab`** runs a local [Verdaccio](https://verdaccio.org) registry as a background daemon. When you publish, packages go through a real `npm publish` to this local Verdaccio. Exports maps, bundled dependencies, the `"files"` array, all validated the same way npm would. Consumer repos install from this registry with a standard `npm install` / `pnpm add`, producing the same `node_modules` tree your users will get. One copy of React. Correct peer dependency resolution. Real lock file entries.

On top of that, **`pkglab`** handles automatic consumer updates, dependency cascading, parallel publishes with rollback, `.npmrc` protection, pre-commit checks, version pruning, and multi-worktree tag isolation. See [Features](#features) for the full list.

## Commands

- `pkglab up` -start the local registry. Deactivates repos from the previous session, then offers a picker to reactivate the ones you need.
- `pkglab down` -stop the registry.
- `pkglab pub [name...]` -publish packages to the local registry. Accepts multiple names. Publishes the current package (if inside one) or all public packages from the workspace root. Computes transitive dependents and republishes the cascade, including sibling workspace deps of dependents. Fingerprints each package and skips unchanged ones: only packages with content changes or whose deps changed get a new version. Auto-updates active consumer repos matching the same tag and prunes old versions in the background. Flags: `--dry-run`, `--single` (skip cascade and fingerprinting), `--shallow` (targets + deps only, no dependent expansion), `--force`/`-f` (ignore fingerprints, republish all), `--verbose`/`-v`, `--tag <name>`/`-t`, `--worktree`/`-w` (auto-detect tag from branch).
- `pkglab add [name[@tag]...]` -install pkglab packages in the current repo. Accepts multiple names, batch installs in one command. Configures `.npmrc`, applies git skip-worktree, and installs using your repo's package manager. Append `@tag` to pin to a tag (e.g. `pkglab add @clerk/pkg@feat1`), or use `--tag`/`-t` to apply a tag to all packages at once (`pkglab add pkg --tag feat1`). Cannot combine `--tag` with inline `@tag` syntax. `--scope` replaces all packages of a given scope in the workspace (e.g. `--scope clerk` or `--scope @clerk`), scanning workspace root + sub-packages for matching deps and verifying all are published before modifying files. Cannot combine `--scope` with positional package names. No args for an interactive picker. Auto-detects catalog entries and updates the catalog source directly (see [Catalog support](#catalog-support)). `--catalog` enables strict mode, erroring if a package is not in any catalog. In a workspace, auto-scans all sub-packages for the dependency and updates all of them (sub-packages using `catalog:` protocol are skipped, handled by catalog auto-detection). `--packagejson`/`-p` opts out of workspace scanning and targets a single sub-package directory (e.g. `pkglab add @clerk/nextjs -p apps/dashboard` from the monorepo root). All targets are remembered for restore.
- `pkglab restore <name>` -restore a pkglab package to its original version across all targets that were updated by `pkglab add` (catalog, sub-packages, or both). Runs the package manager install to sync node_modules, cleans `.npmrc` if no packages remain, and removes skip-worktree. `--all` restores every pkglab package in the repo.
- `pkglab status` -show whether the registry is running and on which port.
- `pkglab logs` -tail Verdaccio logs. `-f` for follow mode.
- `pkglab check` -pre-commit safety check. Scans for pkglab artifacts in `package.json` and `.npmrc` (local versions, registry markers, staged files). Returns exit code 1 if anything is found.
- `pkglab doctor` -diagnose your setup. Checks directory structure, daemon health, registry connectivity, and skip-worktree flags across all linked repos. Auto-repairs missing flags.
- `pkglab pkg rm <name...>` -remove packages from the local registry entirely (API + storage). Accepts multiple names. `--all` removes every pkglab package and clears fingerprint state.
- `pkglab repo ls` -list consumer repos with their active/inactive status and linked packages.
- `pkglab repo on/off [name]` -activate or deactivate a consumer repo. Interactive picker if no name given.
- `pkglab repo reset [name]` -clear all state for a repo. `--all` to reset every repo.
- `pkglab repo rename <old> <new>` -rename a repo's display name.
- `pkglab pkg ls` -list published packages in the local registry, grouped by tag with the latest version per tag.
- `pkglab reset --hard` -wipe all pkglab data and Verdaccio storage. Stops the daemon if running.
- `pkglab reset --fingerprints` -clear the fingerprint cache. Next `pub` will republish all packages regardless of content changes.

Wire `check` into a git hook:

```bash
# .git/hooks/pre-commit (or via your hook manager)
pkglab check
```

## Multi-worktree support

When working on multiple branches simultaneously using git worktrees, you can publish from each worktree with a different tag to avoid version conflicts.

```bash
# From the main worktree
pkglab pub

# From a feature worktree
pkglab pub --tag feat-auth
# or auto-detect from branch name
pkglab pub --worktree

# Consumer repos pin to a specific tag
pkglab add @clerk/pkg@feat-auth
# or use --tag to apply a tag to all packages at once
pkglab add @clerk/pkg --tag feat-auth

# Replace all packages of a scope with their local versions
pkglab add --scope clerk --tag feat-auth

# Or use the interactive picker to browse packages and tags
pkglab add
```

Each tag gets its own version channel. Publishing untagged only auto-updates consumers that are also untagged, and publishing with `--tag feat-auth` only updates consumers pinned to `feat-auth`. Pruning also respects tags, keeping the N most recent versions per tag per package.

Branch names are sanitized for use as tags: `feat/auth-rewrite` becomes `feat-auth-rewrite`. Tags are capped at 50 characters.

## Catalog support

If your consumer repo uses the `catalog:` protocol (Bun or pnpm workspaces), pkglab auto-detects catalog entries and updates the catalog source directly, preserving `catalog:` references in individual package.json files.

```bash
# Auto-detects that these packages are in a catalog and updates the catalog source
pkglab add @clerk/backend @clerk/shared

# Use --catalog for strict mode (errors if a package is not in any catalog)
pkglab add --catalog @clerk/backend @clerk/shared

# Restore puts the original catalog versions back
pkglab restore --all
```

pkglab auto-detects which catalog format your workspace uses:

For bun/npm workspaces, catalogs live in the root package.json:

```json
{
  "catalog": {
    "@clerk/backend": "^3.0.0",
    "@clerk/shared": "^2.0.0"
  }
}
```

For pnpm workspaces, catalogs live in pnpm-workspace.yaml:

```yaml
catalog:
  "@clerk/backend": "^3.0.0"
  "@clerk/shared": "^2.0.0"
```

Named catalogs (`catalogs.react19`, etc.) are also supported in both formats. pkglab finds which catalog contains each package automatically.

When `pkglab pub` auto-updates consumer repos, catalog-linked packages are updated in the catalog (not in individual package.json files), preserving the `catalog:` references.

Bun caveat: bun caches registry metadata for up to 5 minutes, so freshly published versions are invisible to a plain `bun install`. pkglab works around this by temporarily setting `disableManifest = true` in `bunfig.toml` during consumer updates, then restoring it. This will become unnecessary once bun supports catalogs in `bun add` directly, at which point pkglab can use the non-catalog install path for bun.

## How versioning works

**`pkglab`** generates versions in the format `0.0.0-pkglab.{timestamp}` (untagged) or `0.0.0-pkglab-{tag}.{timestamp}` (tagged). The monotonic timestamp ensures versions always increment, even across rapid publishes. The `0.0.0-pkglab` prefix makes these versions instantly recognizable and ensures they sort below any real release.

When using tags, each tag gets its own version channel. Publishing with `--tag feat1` only updates consumers pinned to `feat1`, leaving other consumers untouched. This lets you work on multiple branches simultaneously from different git worktrees without version conflicts.

## Why not ...

`npm link` - symlinks cause duplicate module instances. React, styled-components, and anything using `instanceof` or React context can break with two copies in the tree. A single `npm install` can silently remove links. No lock file entries, so your CI and teammates can't reproduce the setup.

`yalc` - injects `.yalc` directories and `file:.yalc/...` references into `package.json`. Lock files end up with local paths instead of registry URLs. The install shape you test against doesn't match what your users get from a real `npm install`.

`pnpm overrides` / `yarn resolutions` - manual `package.json` edits that are easy to forget and commit. No auto-update on republish. When pointed at local or workspace targets, they can bypass registry validation entirely, so you miss broken exports maps, missing `"files"`, and unresolved `workspace:` / `catalog:` protocols until you actually publish to npm.

`workspace:^` - only works within a single monorepo. Doesn't help when the consumer is a separate repository. Within the workspace, packages resolve to local copies during install, so version resolution bugs only appear once you actually publish. On top of that, during snapshot or canary releases, `workspace:^` resolves to caret ranges that can match the wrong pre-release versions: `^3.0.0-canary.v20251211` satisfies `3.0.0-snapshot.v20251204` because semver sorts `snapshot` after `canary`.

Standalone Verdaccio - gives you the registry, but you still have to manage the daemon lifecycle, generate versions, manually install in every consumer, track which repos are linked, prune old versions, and protect against committing localhost URLs. **`pkglab`** automates all of that.

## Design decisions

**The duplicate-instance problem.** In a monorepo like Clerk's, `@clerk/nextjs` depends on both `@clerk/react` and `@clerk/backend`, which both depend on `@clerk/shared`. If you publish `@clerk/react` and cascade to `nextjs`, but `backend` isn't in the publish set, the consumer ends up with two versions of `@clerk/shared`: a new one (from the react cascade) and an old one (from the previous backend publish). Two versions of the same package means two module instances in Node.js, even if the code is identical. Singleton state isn't shared, `instanceof` checks fail across the boundary, and React contexts created by one version are invisible to the other.

**Close under deps.** The cascade now ensures every published package has all its workspace dependencies also in the publish set. If `nextjs` is being published and it depends on `backend`, `backend` gets pulled in. This eliminates floating `workspace:` references that could resolve to stale versions. Any workspace shorthand dep not covered by the cascade is treated as a bug and throws an error at publish time.

**Why not publish the full connected component?** The obvious fix is to publish every package connected through the dependency graph. But in a monorepo where a shared utility connects everything, publishing any one package would publish the entire repo. For Clerk, that's ~15 packages when you only changed one.

**Content-aware publishing.** Instead of giving every package a new version, pkglab fingerprints each package by globbing the publishable file set (the `files` field, always-included files like package.json/README/LICENSE, and entry points from main/module/types/bin/exports) and SHA-256 hashing their contents. Packages are classified in topological order: "changed" if the content hash differs from the previous publish, "propagated" if the content is the same but a dependency got a new version, or "unchanged" if nothing is different. Unchanged packages keep their existing version and are skipped entirely.

**Two-phase cascade.** The cascade doesn't compute all dependents upfront. Instead, it works in two phases: first fingerprint, then expand. This matters because expanding dependents from an unchanged package is pointless (it kept its old version, so nothing downstream needs updating). Consider this workspace:

```
pkgA (shared utility)
  ├── pkgB ── pkgD (target)
  └── pkgC
```

You run `pkglab pub` from pkgD. Phase one pulls in pkgD's transitive deps (pkgB, pkgA) and fingerprints them. What happens next depends on what actually changed:

Scenario 1: you edited pkgA.
```
pkgA (shared utility)    ← changed
  ├── pkgB ── pkgD       ← propagated, propagated
  └── pkgC               ← pulled in as dependent of pkgA
```
pkgA is classified as "changed," so phase two expands its dependents. pkgC gets pulled into scope because it depends on the package that changed. All four packages are published with new versions, so consumers see a consistent set.

Scenario 2: pkgA is unchanged.
```
pkgA (shared utility)    ← unchanged, skipped
  ├── pkgB ── pkgD       ← changed (you edited pkgB or pkgD)
  └── pkgC               ← not in scope, stays on old version
```
pkgA keeps its existing version and pkgC is never pulled in. The cascade stays narrow: only pkgB and pkgD get new versions. Consumers already have a working pkgA, so there's no inconsistency.

This two-phase approach gives you the best of both worlds. Narrow publishes when nothing upstream changed, automatic expansion when a shared dependency did change. The loop repeats until no new packages are added (a fixpoint), so deeply nested dependency changes propagate correctly through the entire graph.

**The cascade in three steps.**

1. DOWN (deps): pull in transitive deps of the target, unconditionally. These must be in scope so `workspace:^` references resolve.
2. UP (dependents): expand from packages whose content actually changed. If `shared` is unchanged, don't cascade to `express`/`remix`. If `shared` changed, pull them in.
3. PUBLISH filter: of the dependents pulled in by step 2, only publish the ones a consumer has installed (via `pkglab add`). `express` not consumed? Skip it.

When no consumer repos are active (you haven't run `pkglab add` anywhere), the consumed set is empty and the filter removes all dependents. The result is targets + deps only. Once you add a consumer repo, dependents of changed packages start flowing through.

`--shallow` skips step 2 entirely: targets + their transitive deps, no dependent expansion, regardless of whether consumer repos exist. Useful for a quick publish when you know you only care about the target.

Trade-off: adding a previously-skipped package via `pkglab add` gives the last-published version until the next `pkglab pub`.

**Batched consumer installs.** When auto-updating consumer repos, pkglab batches all packages into a single install command per repo (`pnpm add a@v1 b@v2 c@v3`) instead of running one command per package. If the install fails, package.json changes are rolled back so the repo stays consistent with its node_modules.

## Configuration

**`pkglab`** stores its state in `~/.pkglab/`. The config file at `~/.pkglab/config.yaml` supports:

- `port`: Verdaccio port (default: 4873)
- `prune_keep`: number of old versions to retain per package (default: 3)

Logs are written to `/tmp/pkglab/verdaccio.log`.

## Safety

**`pkglab`** is designed to prevent local development artifacts from leaking into your codebase:

- `git update-index --skip-worktree .npmrc` is applied automatically when you `pkglab add`, so your localhost registry URL won't show up in `git status` (requires `.npmrc` to be tracked by git)
- `pkglab restore` restores original package versions and cleans up `.npmrc`
- `pkglab check` scans for any remaining artifacts and returns a non-zero exit code, wire it into your pre-commit hook or CI
- `pkglab doctor` verifies and repairs skip-worktree flags across all linked repos

## Acknowledgments

- [yalc](https://github.com/wclr/yalc) pioneered the copy-based approach to local package development and showed that symlinks aren't the only way. pkglab takes the idea further by using a real registry, but yalc remains a great lighter-weight option if you don't need registry-level validation. Thank you to the yalc maintainers for paving the way.
- Banner style inspired by our friends at [askfeather.ai](https://askfeather.ai).

## License

MIT
