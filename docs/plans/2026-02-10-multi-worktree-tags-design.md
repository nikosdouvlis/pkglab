# Multi-Worktree Tag Support

Publish from multiple git worktrees without version conflicts. Consumers pin to a specific tag (branch channel) per package.

## Version Format

Current: `0.0.0-pkglab.{YY-MM-DD}--{HH-MM-SS}.{timestamp}`

New:
- Untagged: `0.0.0-pkglab.{timestamp}`
- Tagged: `0.0.0-pkglab-{tag}.{timestamp}`

Date/time portion dropped. Timestamp alone provides ordering and uniqueness.

Parsing rules:
- `0.0.0-pkglab.` prefix = untagged
- `0.0.0-pkglab-` prefix = tagged, tag is between `pkglab-` and the last `.`
- `ispkglabVersion()` requires char after "pkglab" to be `.` or `-`
- `extractTimestamp()` reads after last dot (unchanged)
- `extractTag(version)` returns tag string or null
- Old format versions treated as untagged (backwards compat)

Tag sanitization (`sanitizeTag()`):
- Replace `/` with `-`
- Strip anything not alphanumeric or hyphen
- Collapse consecutive hyphens
- Trim leading/trailing hyphens
- Cap at 50 chars, warn if truncated (not silent)
- Error if result is empty

Shared `sanitizeTag()` used in both pub and add paths.

## Pub Command

New flags (mutually exclusive):
- `--tag <name>` / `-t <name>` — explicit tag
- `--worktree` / `-w` — auto-detect from git branch

No flag = untagged, same as today.

`--worktree` behavior:
- Reads branch via `git rev-parse --abbrev-ref HEAD`
- Sanitizes branch name with `sanitizeTag()`
- Errors on detached HEAD: "Cannot detect branch name, use --tag instead"

`generateVersion(tag?)`:
- No tag: `0.0.0-pkglab.{timestamp}`
- With tag: `0.0.0-pkglab-{tag}.{timestamp}`

Auto-update after publish:
- Only updates consumer repos pinned to the matching tag
- Untagged pub updates untagged consumers
- Tagged pub updates consumers with that exact tag

Publish lock unchanged. Verbose output includes the tag.

## Consumer Side

Explicit: `pkglab add pkg@tag`
- Scoped packages: split on last `@` (so `@scope/pkg@tag` works)
- Sanitize input tag before lookup
- Error if no versions found for that tag, listing available tags
- Error shows both raw input and sanitized form if they differ

Interactive: `pkglab add` (no args)
1. Checkbox: select packages (space to toggle, enter to confirm)
2. For each selected package: select tag (skip if only one tag)
3. Install all selected with their chosen tags

Uses `@inquirer/prompts`. Already-picked packages show their tag inline in the list.

`PackageLink` type change:
```
PackageLink {
  original: string
  current: string
  tag?: string        // null/undefined = untagged
}
```

Version resolution:
- `pkglab add pkg` — latest untagged version (not latest across all tags)
- `pkglab add pkg@tag` — latest version with that tag

`pkglab rm` restores original version, clears tag field.

`pkglab pkgs ls` shows tags per package:
```
@clerk/clerk-js
  (untagged)   0.0.0-pkglab.1707568245000
  feat-hello   0.0.0-pkglab-feat-hello.1707568300000
```

## Pruning

Default: keep N most recent versions per tag per package. Untagged is its own group.

Post-pub prune: only prunes within the published tag's group. Prune worker receives the tag as input.

`pkglab prune` (manual): per-tag pruning by default. The existing `--all` flag keeps its current meaning (remove all pkglab versions). No new flag needed for cross-tag behavior.

Active repo references still protected from pruning.

`prune_keep` config controls N. No per-tag config.

## Error Handling

Publish side:
- `--tag` + `--worktree` together: "Cannot use --tag and --worktree together"
- `--worktree` on detached HEAD: "Cannot detect branch name, use --tag instead"
- `--worktree` or `--tag` sanitizes to empty: "Branch/tag name '{raw}' cannot be used as a tag, use --tag instead"
- Tag > 50 chars: warn and truncate

Consumer side:
- `pkglab add pkg@tag` no matching versions: "No versions found for '{pkg}' with tag '{tag}'. Available tags: {list}"
- `pkglab add pkg@tag` no package at all: "Package '{pkg}' not found in registry"

Other:
- `check.ts` updated to detect both `0.0.0-pkglab.` and `0.0.0-pkglab-` patterns
- Old format versions participate as untagged in all operations

## Files to Change

- `src/lib/version.ts` — new format, `generateVersion(tag?)`, `extractTag()`, `sanitizeTag()`, updated `ispkglabVersion()`
- `src/types.ts` — `PackageLink.tag` field
- `src/commands/pub.ts` — `--tag`/`--worktree` flags, tag-aware auto-update
- `src/commands/add.ts` — `pkg@tag` parsing (last `@`), interactive picker, tag-aware version resolution
- `src/lib/consumer.ts` — tag-aware update filtering
- `src/lib/prune.ts` — per-tag grouping
- `src/lib/prune-worker.ts` — accept tag input, scoped pruning
- `src/commands/prune.ts` — per-tag default behavior
- `src/commands/check.ts` — detect tagged versions
- `src/commands/pkgs/ls.ts` — show tags per package
- `src/lib/repo-state.ts` — read/write tag field
