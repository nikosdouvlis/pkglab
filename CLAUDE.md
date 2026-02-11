# pkglab

Local package development CLI with an embedded Verdaccio registry. Publish workspace packages locally and auto-update consumer repos.

Runtime: Bun
CLI framework: citty
Colors: `Bun.color()` via `src/lib/color.ts` (no picocolors)

## CLI commands

Top-level:
- `pkglab up` — start the local Verdaccio registry
- `pkglab down` — stop the registry
- `pkglab status` — show registry status
- `pkglab logs` — show registry logs
- `pkglab pub [name...]` — publish workspace packages to local registry, auto-updates active consumer repos. Accepts multiple names. Fingerprints packages and skips unchanged ones. Flags: `--single` skip cascade/fingerprinting, `--force`/`-f` ignore fingerprints (republish all), `--tag`/`-t` publish with tag, `--worktree`/`-w` auto-detect tag from branch, `--dry-run`, `--verbose`/`-v`
- `pkglab add [name[@tag]...]` — add pkglab packages to the current repo. Accepts multiple names. No args for interactive picker. Batch installs in one command.
- `pkglab restore <name>` — restore a pkglab package to its original version, runs pm install to sync node_modules. `--all` restores all packages in the repo.
- `pkglab doctor` — diagnose issues
- `pkglab check` — check package status
- `pkglab reset --hard` — wipe all pkglab data and Verdaccio storage
- `pkglab reset --fingerprints` — clear fingerprint cache, forces full republish on next pub

Subcommands:
- `pkglab repo ls` — list consumer repos
- `pkglab repo on` — activate a repo
- `pkglab repo off` — deactivate a repo
- `pkglab repo reset` — reset repo state
- `pkglab repo rename` — rename a repo
- `pkglab pkg ls` — list published packages
- `pkglab pkg rm <name...>` — remove packages from registry (also `--all`)

## Workflow

1. `pkglab up` — start the local registry
2. `pkglab pub` — publish workspace packages (from the library repo)
3. `pkglab add <pkg>` — install a pkglab package in a consumer repo (run from consumer repo dir)
4. Iterate: make changes to the library, run `pkglab pub` again — active consumer repos are auto-updated
5. `pkglab restore <pkg>` or `pkglab restore --all` — restore original versions when done
6. `pkglab down` — stop the registry

For multi-worktree workflows, use tags to isolate version channels:
- `pkglab pub -t feat1` or `pkglab pub -w` (auto-detect from branch)
- `pkglab add pkg@feat1` (consumer pins to that tag)
- Each tag's publishes only update consumers pinned to the same tag

## Project layout

- `src/index.ts` — entry point, registers all commands via lazy imports
- `src/commands/` — one file per command, each exports `defineCommand()` as default
- `src/commands/repos/`, `src/commands/pkg/` — subcommand groups with their own index.ts
- `src/lib/` — shared utilities (config, daemon, publisher, registry, fingerprint, etc.)
- `src/types.ts` — all shared interfaces

Config and state live in `~/.pkglab/`. Verdaccio storage at `~/.pkglab/verdaccio/storage/`. Fingerprint state at `~/.pkglab/fingerprints.json`.

## Conventions

- Bun APIs over Node when available (Bun.file, Bun.write, Bun.spawn)
- Strict tsconfig with noUnusedLocals and noUnusedParameters
- No test framework set up
- No linter/formatter config — tsconfig strict mode is the guardrail
- Custom errors extend `pkglabError` in `src/lib/errors.ts`
- Logging through `src/lib/log.ts` (info, success, warn, error, dim, line)
- Class/function naming uses lowercase "pkglab" (pkglabConfig, pkglabError, ispkglabVersion)

## Adding commands

1. Create `src/commands/<name>.ts` exporting `defineCommand()` as default
2. Register in `src/index.ts` subCommands with a lazy import
3. Use `args` for CLI flags, `run({ args })` for the handler

## Cascade and fingerprinting

`pkglab pub` computes a cascade: target + transitive deps + transitive dependents, closed under deps (every published package has its workspace deps in the set). Private packages are excluded from the closure.

Before publishing, each package is fingerprinted using `Bun.Glob` + `Bun.CryptoHasher` (SHA-256) to hash the publishable file set (the `files` field, always-included files, and entry points from main/module/types/bin/exports). Falls back to `npm pack --dry-run --json` for packages with bundledDependencies. Packages are classified in topological order:
- "changed": content hash differs from previous publish
- "propagated": content same, but a workspace dep was changed/propagated
- "unchanged": content same, no deps changed (skipped, keeps existing version)

Fingerprint state is stored per workspace, per package, per tag in `~/.pkglab/fingerprints.json`. Treated as a cache: missing/corrupt state triggers a full republish. State is saved after consumer updates succeed.

When active consumer repos exist, the cascade filters dependents: only dependents that some consumer has installed (via `pkglab add`) are included. This avoids publishing packages nobody is using. If no active repos exist, all dependents are included. Trade-off: `pkglab add` of a previously-skipped package gives a stale version until the next `pkglab pub`.

`--single` bypasses cascade and fingerprinting entirely.
`--force`/`-f` ignores previous fingerprint state (republishes all packages) but still computes and saves new fingerprints.

## Pub command output

Default output shows a color-coded scope summary (package list with scope/change reasons), then spinners for publishing. `--verbose`/`-v` adds the detailed cascade breakdown (dependency lists, cascading-up graph) and private-package warnings.
Pruning runs in a detached subprocess (`src/lib/prune-worker.ts`) to avoid blocking exit.

## Version format

Untagged: `0.0.0-pkglab.{timestamp}`
Tagged: `0.0.0-pkglab-{tag}.{timestamp}`

Old format (`0.0.0-pkglab.{YY-MM-DD}--{HH-MM-SS}.{timestamp}`) treated as untagged for backwards compat.

extractTimestamp reads after the last dot, extractTag reads between `pkglab-` and the last dot.

## Testing

IMPORTANT: After making changes to commands or core lib code, always run `bun run test:e2e` and verify all tests pass before committing.

IMPORTANT: After changing commands, flags, or CLI behavior, always check README.md and CLAUDE.md are up to date.

## /cmt Skill Config

Scopes: pub, pkgs, repos, daemon, consumer, registry, version, config
