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
- `pkglab pub [name]` — publish workspace packages to local registry, auto-updates active consumer repos. Flags: `--single` skip cascade, `--tag`/`-t` publish with tag, `--worktree`/`-w` auto-detect tag from branch
- `pkglab add [name[@tag]]` — add a pkglab package to the current repo. No args for interactive picker
- `pkglab rm <name>` — remove a pkglab package, restore original version
- `pkglab doctor` — diagnose issues
- `pkglab prune` — clean up old versions from storage
- `pkglab check` — check package status
- `pkglab reset --hard` — wipe all pkglab data and Verdaccio storage

Subcommands:
- `pkglab repos ls` — list consumer repos
- `pkglab repos on` — activate a repo
- `pkglab repos off` — deactivate a repo
- `pkglab repos reset` — reset repo state
- `pkglab repos rename` — rename a repo
- `pkglab pkg ls` — list published packages

## Workflow

1. `pkglab up` — start the local registry
2. `pkglab pub` — publish workspace packages (from the library repo)
3. `pkglab add <pkg>` — install a pkglab package in a consumer repo (run from consumer repo dir)
4. Iterate: make changes to the library, run `pkglab pub` again — active consumer repos are auto-updated
5. `pkglab rm <pkg>` — restore original version when done
6. `pkglab down` — stop the registry

For multi-worktree workflows, use tags to isolate version channels:
- `pkglab pub -t feat1` or `pkglab pub -w` (auto-detect from branch)
- `pkglab add pkg@feat1` (consumer pins to that tag)
- Each tag's publishes only update consumers pinned to the same tag

## Project layout

- `src/index.ts` — entry point, registers all commands via lazy imports
- `src/commands/` — one file per command, each exports `defineCommand()` as default
- `src/commands/repos/`, `src/commands/pkg/` — subcommand groups with their own index.ts
- `src/lib/` — shared utilities (config, daemon, publisher, registry, etc.)
- `src/types.ts` — all shared interfaces

Config and state live in `~/.pkglab/`. Verdaccio storage at `~/.pkglab/verdaccio/storage/`.

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

## Pub command output

Default output is concise with spinners. `--verbose`/`-v` shows full detail.
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
