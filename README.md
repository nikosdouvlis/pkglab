<p align="center">
  <img src="docs/img/banner.png" alt="pkglab banner, style inspired by askfeather.ai" />
</p>

Local package development CLI for monorepos. Publish workspace packages to an embedded registry, iterate, and auto-update consumer repos without the headaches of `npm link`, yalc, or manual overrides.

Also available as `pkgl` for short.

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Install](#install)
- [Configuration](#configuration)
- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Commands](#commands)
- [Why not ...](#why-not-)
- [How versioning works](#how-versioning-works)
- [Multi-worktree support](#multi-worktree-support)
- [Safety](#safety)
- [Acknowledgments](#acknowledgments)

## Features

- Real `npm publish` to a local Verdaccio registry, so you test the same install your users get
- Automatic consumer repo updates after every publish
- Dependency cascade awareness (change a shared util, all dependent packages get republished)
- Multi-worktree tag support: publish from multiple git worktrees in parallel without version conflicts, each worktree gets its own version channel
- Interactive package picker with tag selection when running `pkglab add` with no arguments
- Git skip-worktree protection on `.npmrc` so localhost registry URLs don't leak into commits
- Pre-commit safety checks (`pkglab check`) to catch local artifacts before they reach your repo
- Automatic version pruning per tag so the local registry doesn't grow forever
- Works with any consumer package manager: npm, pnpm, yarn, or bun

## Quick start

```bash
# Start the local registry
pkglab up

# From your library monorepo, publish all public packages
pkglab pub

# From a consumer repo, install a package from the local registry
pkglab add @your-org/your-package

# Make changes to the library, then re-publish
# Active consumer repos update automatically
pkglab pub

# When done, restore the original version
pkglab rm @your-org/your-package

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

From source (requires Bun):

```
bun install -g pkglab
```

Your consumer repos can use any package manager: npm, pnpm, yarn, or bun. pkglab shells out to `npm` for publishing, so Node.js needs to be available on your machine.

Supported on macOS (ARM64, x64) and Linux (x64, ARM64).

## Configuration

**`pkglab`** stores its state in `~/.pkglab/`. The config file at `~/.pkglab/config.yaml` supports:

- `port`: Verdaccio port (default: 4873)
- `prune_keep`: number of old versions to retain per package (default: 3)

Logs are written to `/tmp/pkglab/verdaccio.log`.

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

`pkglab up` - start the local Verdaccio registry. Deactivates all repos from the previous session, then offers an interactive picker to reactivate the ones you need.

`pkglab down` - stop the registry.

`pkglab pub [name]` - publish workspace packages to the local registry. If run from a package directory, publishes that package. Otherwise publishes all public packages. Computes transitive dependents and republishes the entire cascade. Auto-updates active consumer repos (matching the same tag) and prunes old versions in the background.

Flags: `--dry-run` preview without publishing, `--fast` skip dependency cascade, `--verbose` / `-v` show full output instead of spinners, `--tag <name>` / `-t` publish with a tag for multi-worktree support, `--worktree` / `-w` auto-detect tag from the current git branch name.

`pkglab add [name[@tag]]` - add a **`pkglab`** package to the current repo. Configures `.npmrc` to point at the local registry, applies git skip-worktree, and installs using your repo's package manager (`npm install`, `pnpm add`, `yarn add`, or `bun add` depending on your lock file). Append `@tag` to pin to a specific tag (e.g. `pkglab add @org/pkg@feat1`). Run with no arguments for an interactive picker where you can select packages and tags.

`pkglab rm <name>` - remove a **`pkglab`** package. Restores the original version in `package.json` from before `pkglab add`, cleans `.npmrc` if no packages remain, and removes skip-worktree. Run your package manager's install afterward to sync the lock file.

`pkglab status` - show whether the registry is running and on which port.

`pkglab logs` - tail Verdaccio logs (written to `/tmp/pkglab/verdaccio.log`). `-f` for follow mode.

`pkglab check` - pre-commit safety check. Scans `package.json` and `.npmrc` for **`pkglab`** artifacts (local versions, registry markers, staged files). Returns exit code 1 if anything is found. Wire it into a git hook:

```bash
# .git/hooks/pre-commit (or via your hook manager)
pkglab check
```

`pkglab doctor` - diagnose your setup. Checks Bun version, directory structure, daemon health, registry connectivity, and skip-worktree flags on all linked repos. Auto-repairs missing flags.

`pkglab prune` - manually clean old versions from Verdaccio storage. Keeps the 3 most recent versions per tag per package (configurable) and preserves any version currently linked in an active repo. Use `--all` to remove all pkglab versions.

`pkglab repos ls` - list consumer repos with their active/inactive status and linked packages.

`pkglab repos on [name]` - activate a consumer repo. Interactive picker if no name given.

`pkglab repos off [name]` - deactivate a repo (stops auto-updates on publish).

`pkglab repos reset [name]` - clear all state for a repo. Use `--all` to reset every repo.

`pkglab repos rename <old> <new>` - rename a repo's display name.

`pkglab pkgs ls` - list **`pkglab`**-published packages in the local registry, grouped by tag with the latest version per tag.

## Why not ...

`npm link` - symlinks cause duplicate module instances. React, styled-components, and anything using `instanceof` or React context can break with two copies in the tree. A single `npm install` can silently remove links. No lock file entries, so your CI and teammates can't reproduce the setup.

`yalc` - injects `.yalc` directories and `file:.yalc/...` references into `package.json`. Lock files end up with local paths instead of registry URLs. The install shape you test against doesn't match what your users get from a real `npm install`.

`pnpm overrides` / `yarn resolutions` - manual `package.json` edits that are easy to forget and commit. No auto-update on republish. When pointed at local or workspace targets, they can bypass registry validation entirely, so you miss broken exports maps, missing `"files"`, and unresolved `workspace:` / `catalog:` protocols until you actually publish to npm.

`workspace:^` - only works within a single monorepo. Doesn't help when the consumer is a separate repository. Within the workspace, packages resolve to local copies during install, so version resolution bugs only appear once you actually publish. On top of that, during snapshot or canary releases, `workspace:^` resolves to caret ranges that can match the wrong pre-release versions: `^3.0.0-canary.v20251211` satisfies `3.0.0-snapshot.v20251204` because semver sorts `snapshot` after `canary`.

Standalone Verdaccio - gives you the registry, but you still have to manage the daemon lifecycle, generate versions, manually install in every consumer, track which repos are linked, prune old versions, and protect against committing localhost URLs. **`pkglab`** automates all of that.

## How versioning works

**`pkglab`** generates versions in the format `0.0.0-pkglab.{timestamp}` (untagged) or `0.0.0-pkglab-{tag}.{timestamp}` (tagged). The monotonic timestamp ensures versions always increment, even across rapid publishes. The `0.0.0-pkglab` prefix makes these versions instantly recognizable and ensures they sort below any real release.

When using tags, each tag gets its own version channel. Publishing with `--tag feat1` only updates consumers pinned to `feat1`, leaving other consumers untouched. This lets you work on multiple branches simultaneously from different git worktrees without version conflicts.

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
pkglab add @org/pkg@feat-auth

# Or use the interactive picker to browse packages and tags
pkglab add
```

Each tag gets its own version channel. Publishing untagged only auto-updates consumers that are also untagged, and publishing with `--tag feat-auth` only updates consumers pinned to `feat-auth`. Pruning also respects tags, keeping the N most recent versions per tag per package.

Branch names are sanitized for use as tags: `feat/auth-rewrite` becomes `feat-auth-rewrite`. Tags are capped at 50 characters.

## Safety

**`pkglab`** is designed to prevent local development artifacts from leaking into your codebase:

- `git update-index --skip-worktree .npmrc` is applied automatically when you `pkglab add`, so your localhost registry URL won't show up in `git status` (requires `.npmrc` to be tracked by git)
- `pkglab rm` restores the original package version and cleans up `.npmrc`
- `pkglab check` scans for any remaining artifacts and returns a non-zero exit code, wire it into your pre-commit hook or CI
- `pkglab doctor` verifies and repairs skip-worktree flags across all linked repos

## Acknowledgments

- [yalc](https://github.com/wclr/yalc) pioneered the copy-based approach to local package development and showed that symlinks aren't the only way. pkglab takes the idea further by using a real registry, but yalc remains a great lighter-weight option if you don't need registry-level validation. Thank you to the yalc maintainers for paving the way.
- Banner style inspired by our friends at [askfeather.ai](https://askfeather.ai).

## License

MIT
