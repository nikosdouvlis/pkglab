# pkglab

Local package development CLI for monorepos. Publish workspace packages to an embedded registry, iterate, and auto-update consumer repos without the headaches of `npm link`, yalc, or manual overrides.

Also available as `pkgl` for short.

## The problem

Testing local package changes across repos is painful. The existing tools all have real problems.

`npm link` creates symlinks into your source directory. React and other libraries that rely on module identity get duplicated: your app loads one copy from `node_modules` and the linked package resolves a second copy from its own `node_modules`. This causes the classic "hooks can only be called inside the body of a function component" crash, broken contexts, and similar issues. A single `npm install` can also silently blow away your links.

`yalc` improves on this by copying files, but it injects `.yalc` directories and modifies `package.json` with `file:` references that behave differently from real registry installs. Lock files end up with local paths instead of registry URLs. The install you test against is structurally different from what your users will get.

`workspace:^` and `workspace:~` protocols only work within a single workspace. If you need to test a package in a separate consumer repo (the common case), these are useless. Even within a workspace, packages resolve to local copies during install rather than going through the registry, which can mask version resolution bugs that only surface in real published installs.

`pnpm overrides` and `yarn resolutions` require editing the consumer's `package.json`, remembering to undo before committing, and don't auto-update when you change the library. When pointed at local or workspace targets, they bypass registry validation, so you can miss broken exports maps, missing files in the `"files"` array, and unresolved `workspace:` / `catalog:` protocols until you actually publish to npm.

**`pkglab`** solves all of this by publishing to a real npm registry running on your machine.

## How it works

**`pkglab`** runs a local [Verdaccio](https://verdaccio.org) registry as a background daemon. When you publish, packages go through a real `npm publish` to this local Verdaccio. Exports maps, bundled dependencies, the `"files"` array, all validated the same way npm would. Consumer repos install from this registry with a standard `npm install` / `pnpm add`, producing the same `node_modules` tree your users will get. One copy of React. Correct peer dependency resolution. Real lock file entries.

On top of that, **`pkglab`** handles:

- Automatic consumer repo updates after every publish
- Dependency cascade awareness (change a shared util, all dependent packages get republished)
- Parallel publishes with best-effort rollback on failure
- Git skip-worktree protection on `.npmrc` so you don't accidentally commit localhost registry URLs (for git-tracked files)
- Pre-commit safety checks to catch **`pkglab`** artifacts before they reach your repo
- Automatic version pruning so the local registry doesn't grow forever

## Install

```
bun install -g pkglab
```

Requires [Bun](https://bun.sh) and Node.js (**`pkglab`** shells out to `npm` for publishing). Your consumer repos can use any package manager: npm, pnpm, yarn, or bun.

Supported on macOS and Linux.

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

## Commands

`pkglab up` - start the local Verdaccio registry. Deactivates all repos from the previous session, then offers an interactive picker to reactivate the ones you need.

`pkglab down` - stop the registry.

`pkglab pub [name]` - publish workspace packages to the local registry. If run from a package directory, publishes that package. Otherwise publishes all public packages. Computes transitive dependents and republishes the entire cascade. Auto-updates active consumer repos and prunes old versions in the background.

Flags: `--dry-run` preview without publishing, `--fast` skip dependency cascade, `--verbose` / `-v` show full output instead of spinners.

`pkglab add <name>` - add a **`pkglab`** package to the current repo. Configures `.npmrc` to point at the local registry, applies git skip-worktree, and installs using your repo's package manager (`npm install`, `pnpm add`, `yarn add`, or `bun add` depending on your lock file).

`pkglab rm <name>` - remove a **`pkglab`** package. Restores the original version in `package.json` from before `pkglab add`, cleans `.npmrc` if no packages remain, and removes skip-worktree. Run your package manager's install afterward to sync the lock file.

`pkglab status` - show whether the registry is running and on which port.

`pkglab logs` - tail Verdaccio logs (written to `/tmp/pkglab/verdaccio.log`). `-f` for follow mode.

`pkglab check` - pre-commit safety check. Scans `package.json` and `.npmrc` for **`pkglab`** artifacts (local versions, registry markers, staged files). Returns exit code 1 if anything is found. Wire it into a git hook:

```bash
# .git/hooks/pre-commit (or via your hook manager)
pkglab check
```

`pkglab doctor` - diagnose your setup. Checks Bun version, directory structure, daemon health, registry connectivity, and skip-worktree flags on all linked repos. Auto-repairs missing flags.

`pkglab prune` - manually clean old versions from Verdaccio storage. Keeps the 3 most recent versions per package (configurable) and preserves any version currently linked in an active repo.

`pkglab repos ls` - list consumer repos with their active/inactive status and linked packages.

`pkglab repos on [name]` - activate a consumer repo. Interactive picker if no name given.

`pkglab repos off [name]` - deactivate a repo (stops auto-updates on publish).

`pkglab repos reset [name]` - clear all state for a repo. Use `--all` to reset every repo.

`pkglab repos rename <old> <new>` - rename a repo's display name.

`pkglab pkgs ls` - list **`pkglab`**-published packages in the local registry with version counts.

## Why not ...

`npm link` - symlinks cause duplicate module instances. React, styled-components, and anything using `instanceof` or React context can break with two copies in the tree. A single `npm install` can silently remove links. No lock file entries, so your CI and teammates can't reproduce the setup.

`yalc` - injects `.yalc` directories and `file:.yalc/...` references into `package.json`. Lock files end up with local paths instead of registry URLs. The install shape you test against doesn't match what your users get from a real `npm install`.

`pnpm overrides` / `yarn resolutions` - manual `package.json` edits that are easy to forget and commit. No auto-update on republish. When pointed at local or workspace targets, they can bypass registry validation entirely, so you miss broken exports maps, missing `"files"`, and unresolved `workspace:` / `catalog:` protocols until you actually publish to npm.

`workspace:^` - only works within a single monorepo. Doesn't help when the consumer is a separate repository. Within the workspace, packages resolve to local copies during install rather than going through the registry, so version resolution bugs that only appear in real published installs can go unnoticed.

Standalone Verdaccio - gives you the registry, but you still have to manage the daemon lifecycle, generate versions, manually install in every consumer, track which repos are linked, prune old versions, and protect against committing localhost URLs. **`pkglab`** automates all of that.

## How versioning works

**`pkglab`** generates versions in the format `0.0.0-pkglab.YY-MM-DD--HH-MM-SS.{timestamp}`. The monotonic timestamp ensures versions always increment, even across rapid publishes. Before each publish, **`pkglab`** seeds from both the registry and a local file to prevent conflicts. The `0.0.0-pkglab.` prefix makes these versions instantly recognizable and ensures they sort below any real release.

## Configuration

**`pkglab`** stores its state in `~/.pkglab/`. The config file at `~/.pkglab/config.yaml` supports:

- `port`: Verdaccio port (default: 4873)
- `prune_keep`: number of old versions to retain per package (default: 3)

Logs are written to `/tmp/pkglab/verdaccio.log`.

## Safety

**`pkglab`** is designed to prevent local development artifacts from leaking into your codebase:

- `git update-index --skip-worktree .npmrc` is applied automatically when you `pkglab add`, so your localhost registry URL won't show up in `git status` (requires `.npmrc` to be tracked by git)
- `pkglab rm` restores the original package version and cleans up `.npmrc`
- `pkglab check` scans for any remaining artifacts and returns a non-zero exit code, wire it into your pre-commit hook or CI
- `pkglab doctor` verifies and repairs skip-worktree flags across all linked repos

## License

MIT
