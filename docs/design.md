# pkgl design document

A CLI tool for local package development using Verdaccio as a real npm registry. Replaces yalc with a more reliable approach that matches real npm publish/install behavior.

## Problem

Testing local packages during development is painful. Existing solutions have fundamental issues:

- `npm link` / `yarn link`: symlinks cause peer dependency resolution failures, duplicate React instances, and bundler confusion
- `yalc`: copies files directly into node_modules, bypassing the package manager entirely. This means lockfiles are stale, peer deps are unresolved, and the install doesn't match what users will actually get from npm

The core issue: all existing tools diverge from the real npm install path. This creates subtle bugs that only surface when the package is actually published.

## Solution

pkgl runs a local Verdaccio registry and publishes packages to it with synthetic versions. Consumer repos install from it using their native package manager (npm, pnpm, bun). The install path is identical to installing from the real npm registry.

No config files in repos. No build orchestration. No magic.

## Architecture

```
Publisher repo (e.g. Clerk monorepo)
    |
    | pkgl pub @clerk/backend
    v
~/.pkgl/verdaccio/  <-- local Verdaccio instance (127.0.0.1:4873)
    |                    proxies unknown packages to npm
    | pkgl add @clerk/backend
    v
Consumer repo (e.g. test app)
    .npmrc: registry=http://localhost:4873
    package.json: "@clerk/backend": "0.0.0-pkgl.1707500000000"
```

Two roles:

- Publisher repos: run `pkgl pub` to publish packages to Verdaccio
- Consumer repos: run `pkgl add` to install packages from Verdaccio

Connected through a local Verdaccio instance that pkgl manages. Verdaccio proxies anything not published locally to the real npm registry, so non-pkgl packages resolve normally.

## Version strategy

Packages are published as `0.0.0-pkgl.{timestamp_ms}` (e.g. `0.0.0-pkgl.1707500000000`).

- Timestamp uses `max(last_published_ts + 1, Date.now())` to guarantee monotonic ordering even under clock skew
- Each publish is a distinct version in the registry, triggering fresh installs
- Cache-busting: downstream compilers (Next.js, webpack) see a new version and invalidate caches
- The `0.0.0-pkgl.*` pattern is self-documenting in package.json — obvious when a package is from pkgl

Workspace dependencies are pinned to exact pkgl versions in the published package.json. All `workspace:` protocol references (`workspace:^`, `workspace:*`, `workspace:~`) are rewritten to the exact version being published. No `workspace:` specs survive into Verdaccio.

Peer dependencies: workspace peers are pinned to exact pkgl versions. External peers (non-workspace packages) are left as ranges.

## Cascade publish algorithm

When a package is published, pkgl publishes the entire affected dependency chain to ensure consistency.

Algorithm:

1. A package changes (manual `pkgl pub` or triggered by dev workflow)
2. Walk UP the dependency graph: find all workspace packages that transitively depend on the changed package
3. Compute the closure: the changed package + all its transitive dependents
4. For each package in the closure, include its forward workspace dependencies
5. Deduplicate, topologically sort (with deterministic lexical tie-breaking), assign a single timestamp
6. Publish all packages in order
7. On failure mid-chain: rollback by unpublishing all packages from this timestamp. No partial states.

Cycle handling: detect strongly connected components before toposort. If cycles exist, error with the cycle path. Do not attempt to publish cyclic dependency chains.

Example with Clerk's graph (`shared -> backend -> nextjs`, `shared -> react`):

```
Change in shared:
  reverse deps: backend, nextjs, react
  closure + forward deps: shared, backend, react, nextjs
  publish all with timestamp 1707500000000

Change in backend:
  reverse deps: nextjs
  closure + forward deps: shared, backend, nextjs
  publish all with timestamp 1707500000001

Change in nextjs:
  no reverse deps
  closure + forward deps: shared, backend, nextjs
  publish all with timestamp 1707500000002
```

Packages whose code didn't change still get re-published with updated manifests. Their dist files are identical — only the package.json dependency versions change to point to the new timestamp.

Uses `@manypkg/get-packages` for workspace discovery and `dependency-graph` for graph operations. Both are lightweight, stable, and support all major workspace formats (npm, pnpm, bun).

## Consumer registry config

`pkgl add` sets a global registry override in the consumer's `.npmrc`:

```
# pkgl-start
registry=http://localhost:4873
# pkgl-end
```

This redirects all package resolution through Verdaccio. Packages published to pkgl resolve to their `0.0.0-pkgl.*` versions. Everything else is proxied to npm transparently.

Conflict handling: if `.npmrc` already has a `registry=` line (e.g. pointing to a corporate proxy), pkgl errors with a clear message. A future release will add a compatibility mode flag for these setups.

Git safety: pkgl runs `git update-index --skip-worktree .npmrc` after modifying it. The pkgl registry lines exist locally but git ignores them — they won't appear in `git status`, diffs, or get staged accidentally. `pkgl rm` removes the lines and clears the flag. `pkgl doctor` verifies the skip-worktree flag is intact and repairs it if cleared by git operations (merges, rebases).

On first `pkgl add` in a repo, pkgl prints a notice:

```
notice: pkgl added registry entries to .npmrc
These entries point to localhost and will break CI if committed.
pkgl has applied --skip-worktree to prevent accidental commits.
Run pkgl rm to restore your .npmrc.
```

## Scoped installs

When a publish triggers consumer updates, pkgl updates the version in the consumer's `package.json` and runs the PM's native single-package install for each changed package rather than a full `npm install`. For example:

```
npm install @clerk/backend@0.0.0-pkgl.1707500000000
```

pkgl only updates packages that the consumer already has in its `package.json` dependencies. It never adds new dependencies — only updates existing ones that were previously added via `pkgl add`.

pkgl detects the package manager by checking for lockfile presence (pnpm-lock.yaml, bun.lock, package-lock.json). If multiple lockfiles exist, pkgl errors and asks the developer to specify.

## Repo management

Consumer repos are tracked in per-repo files under `~/.pkgl/repos/` when they first run `pkgl add`.

Repo identity: filesystem path (canonicalized via `realpath`) is the internal key. The root package.json name is the display alias. On name collision, auto-suffix with `~2`, `~3`. `pkgl repos rename` allows custom aliases.

Per-repo state file:

```yaml
# ~/.pkgl/repos/my-app.yaml
path: /Users/nikos/Projects/my-app
active: false
packages:
  "@clerk/backend":
    original: "^4.1.0"
    current: "0.0.0-pkgl.1707500000000"
  "@clerk/shared":
    original: "^4.0.0"
    current: "0.0.0-pkgl.1707500000000"
```

The `original` field stores the pre-pkgl version for each package. `pkgl rm @clerk/backend` reads this value and restores it in `package.json`.

On `pkgl start`, all linked repos reset to inactive. Developer activates specific repos for the session:

```
$ pkgl start
pkgl running on http://localhost:4873

Linked repos (all inactive):
  my-app         /Users/nikos/Projects/my-app
  test-suite     /Users/nikos/Projects/test-suite
  demo-store     /Users/nikos/Projects/demo-store

Activate repos: pkgl repos activate <name>
```

After every `pkgl pub`, pkgl prints which active repos received updates:

```
Published 3 packages (ts: 1707500000000):
  @clerk/shared@0.0.0-pkgl.1707500000000
  @clerk/backend@0.0.0-pkgl.1707500000000
  @clerk/nextjs@0.0.0-pkgl.1707500000000

Updated active repos:
  my-app       npm install @clerk/backend@0.0.0-pkgl.1707500000000 ... done
  test-suite   npm install @clerk/backend@0.0.0-pkgl.1707500000000 ... done
```

## Daemon management

`pkgl start` spawns Verdaccio as a detached background process:

- Binds to `127.0.0.1` only (security: not accessible from network)
- PID written to `~/.pkgl/pid`
- Before using PID, validate the process is actually a pkgl-managed Verdaccio (not a stale PID reused by another process)
- Logs written to `/tmp/pkgl/verdaccio.log`
- Verdaccio config and storage under `~/.pkgl/verdaccio/`

`pkgl stop` reads the PID, validates identity, and kills the process. `pkgl logs` tails the log file. `pkgl logs -f` for live streaming.

Port defaults to 4873, configurable in `~/.pkgl/config.yaml`. If the port changes, `pkgl start` updates the `.npmrc` in all linked repos.

Crash recovery: `pkgl start` checks for stale PID files on startup. If the PID file exists but the process is dead, pkgl cleans up and starts fresh. `pkgl doctor` detects and repairs orphaned state.

## Pruning

Every `pkgl pub` automatically prunes old versions per package, keeping the latest 3 (configurable in `~/.pkgl/config.yaml`). Before pruning, pkgl checks active consumer repos to ensure no referenced version is removed. Uses Verdaccio's API to unpublish old versions.

`pkgl prune` runs pruning manually. Since all versions follow the `0.0.0-pkgl.{timestamp}` pattern, sorting and pruning is trivial.

## Concurrency

A global publish mutex at `~/.pkgl/publish.lock` prevents concurrent `pkgl pub` invocations from producing inconsistent states (mixed timestamps, partial publishes). A per-consumer install mutex prevents thrashing when multiple publishes trigger consumer updates.

## Global config

```yaml
# ~/.pkgl/config.yaml
port: 4873
prune_keep: 3
```

Per-repo state files under `~/.pkgl/repos/`:

```yaml
# ~/.pkgl/repos/my-app.yaml
path: /Users/nikos/Projects/my-app
active: false
packages:
  "@clerk/backend":
    original: "^4.1.0"
    current: "0.0.0-pkgl.1707500000000"
```

No config files in publisher or consumer repos. All repo-level state lives in `.npmrc` (registry markers) and `package.json` (version strings) — files that already exist.

## CLI commands

```
pkgl start                     start Verdaccio daemon
pkgl stop                      stop Verdaccio
pkgl status                    server info, active repos, published packages

pkgl pub [@scope/name]         publish package + cascade chain
pkgl pub --fast                publish current dist, skip dep checks
pkgl pub --dry-run             show what would be published

pkgl add @scope/name           add package to consumer repo
pkgl rm @scope/name            remove package, restore original version

pkgl repos ls                  list linked repos
pkgl repos activate <name>     activate repo for auto-updates
pkgl repos deactivate <name>   deactivate repo
pkgl repos reset <name>        reset specific repo
pkgl repos reset --all         reset all repos

pkgl pkgs ls                   list packages in Verdaccio
pkgl prune                     clean old versions
pkgl doctor                    health check (env, registry, daemon, git state)
pkgl logs [-f]                 tail Verdaccio logs
pkgl check                     pre-commit safety check for pkgl artifacts
```

## Package manager support

- npm: supported
- pnpm: supported
- bun: supported (reads .npmrc since v1.1.18)
- yarn berry: not supported

## Tech stack

- Runtime: Bun
- Registry: Verdaccio (embedded, managed by pkgl)
- Workspace discovery: @manypkg/get-packages
- Dependency graph: dependency-graph
- Config: YAML (~/.pkgl/)

## Open questions

- What happens when a consumer runs `npm install` while pkgl is stopped? Verdaccio is down, registry points to localhost, install fails. `pkgl doctor` should detect this state and offer to temporarily restore the original registry. No implicit fallback — explicit is better.
- Storage location for Verdaccio data: `~/.pkgl/verdaccio/` means package tarballs accumulate. Pruning handles versions, but consider adding `max_storage_mb` config for hard limits.
