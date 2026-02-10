# pkglab

Local package development CLI with an embedded Verdaccio registry. Publish workspace packages locally and auto-update consumer repos.

Runtime: Bun
CLI framework: citty
Colors: `Bun.color()` via `src/lib/color.ts` (no picocolors)

## Project layout

- `src/index.ts` — entry point, registers all commands via lazy imports
- `src/commands/` — one file per command, each exports `defineCommand()` as default
- `src/commands/repos/`, `src/commands/pkgs/` — subcommand groups with their own index.ts
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

`0.0.0-pkglab.{YY-MM-DD}--{HH-MM-SS}.{timestamp}`

extractTimestamp reads after the last dot, so both old (bare timestamp) and new formats work.

## /cmt Skill Config

Scopes: pub, pkgs, repos, daemon, consumer, registry, version, config
