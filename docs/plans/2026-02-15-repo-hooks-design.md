# Repo Hooks Design

Per-repo lifecycle hooks for pkglab. Allows consumer repos to run custom scripts at key moments (add, restore, publish-triggered update) so repos can manage their own environment setup, cleanup, and configuration.

Primary use case: a testbed app that needs to point Clerk SDKs to a local API server when local packages are installed, and revert when restored.

## Hook Location

`.pkglab/hooks/` directory in the consumer repo root.

- Co-located with the repo it affects
- Can be committed to version control for team-shared hooks
- Can be gitignored for local-only hooks
- Familiar mental model (similar to `.git/hooks/`)
- `.pkglab/` namespace is extensible for future repo-local config

## Hook Events (7 total)

| Event | Fires when | Abort semantics |
|-------|-----------|-----------------|
| `pre-add` | Before `pkglab add` installs packages | Aborts the add operation |
| `post-add` | After `pkglab add` succeeds | Advisory (warn on failure) |
| `pre-restore` | Before `pkglab restore` reverts packages | Aborts the restore operation |
| `post-restore` | After `pkglab restore` succeeds | Advisory (warn on failure) |
| `pre-update` | Before `pkglab pub` auto-updates this repo | Skips this repo, continues others |
| `post-update` | After `pkglab pub` auto-update succeeds | Advisory (warn on failure) |
| `on-error` | Any operation fails (internal or hook-caused) | Best-effort, non-recursive |

Hooks only fire when packages actually change. No-op updates (fingerprint unchanged, nothing to install) do not trigger hooks.

## Hook Format

No config file needed. Presence of the file = hook is active. Three supported formats:

- `post-add` - extensionless, must be executable (+x), runs directly via shebang
- `post-add.sh` - shell script, run with `bash`
- `post-add.ts` - TypeScript, run with `bun`

Discovery order: `.ts` > `.sh` > extensionless. First match wins. If multiple formats exist for the same event, only the highest-priority one runs (no ambiguity).

```
my-testbed-app/
  .pkglab/
    hooks/
      post-add.ts       # TypeScript, run with bun
      post-restore.sh   # Shell, run with bash
      post-update       # Executable, run directly
      on-error.ts       # TypeScript (optional)
  src/
  package.json
```

Execution by extension:
- `.ts`: `bun run <hookPath> <jsonPayload>`
- `.sh`: `bash <hookPath> <jsonPayload>`
- (none): `<hookPath> <jsonPayload>` (must have +x and shebang)

v1 is macOS/Linux only. Windows support (`.cmd`/`.ps1`) can be added later.

## Context Passing

Single JSON string passed as the first CLI argument (argv[1]) to hook scripts. No env vars, no temp files. One source of truth.

`pkglab hooks init` writes a local `payload.d.ts` into `.pkglab/hooks/` so TypeScript hooks get full type safety without needing pkglab as a dependency.

## Payload schema

```json
{
  "schemaVersion": 1,
  "event": "add",
  "phase": "pre",
  "packages": [
    { "name": "@clerk/nextjs", "version": "0.0.0-pkglab.1234", "previous": "5.1.0" }
  ],
  "tag": null,
  "repoPath": "/path/to/testbed",
  "registryUrl": "http://127.0.0.1:4873",
  "packageManager": "bun",
  "error": null
}
```

For `on-error`, the `error` field is populated:
```json
{
  "schemaVersion": 1,
  "event": "update",
  "phase": "error",
  "packages": [...],
  "error": {
    "stage": "operation",
    "message": "npm install failed with exit code 1",
    "failedHook": null
  }
}
```

## Usage in hooks

Shell:
```bash
#!/bin/bash
json="$1"
event=$(echo "$json" | jq -r '.event')
```

TypeScript/Bun:
```typescript
import type { PkglabHookPayload } from './payload';
const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
```

## Execution context

Hooks always run with `cwd` set to the consumer repo root (the directory containing the `.pkglab/hooks/` folder). This means:
- Relative paths like `.env.local` or `apps/dashboard/.env` resolve from the repo root
- `payload.repoPath` provides the absolute path if needed
- The hook file itself lives at `.pkglab/hooks/<name>` relative to cwd

Example: if your repo is at `/Users/me/projects/testbed-app`, the hook runs with cwd `/Users/me/projects/testbed-app` and `payload.repoPath` is `/Users/me/projects/testbed-app`.

## Safety notes

- Hooks are spawned with `Bun.spawn` (no shell interpolation)
- No secrets or auth tokens in the payload
- Payload size is bounded by the package list (well within ARG_MAX limits for typical use)

## Execution Model

## Timeout

Default 30 seconds per hook. Overridable via `--hook-timeout` flag or `PKGLAB_HOOK_TIMEOUT_MS` env var. No per-repo config for v1.

## Ordering

Hooks fire once per operation, not once per package. The packages list contains all packages being operated on in that batch.

## Pre-hook abort behavior

- `add` / `restore` (single-repo): pre-hook abort = non-zero exit from pkglab. The operation did not happen.
- `pub` fan-out (multi-repo): pre-hook abort = skip that repo, continue with others. Summary shows which repos were skipped. pkglab exits zero if publishes succeeded, even if some consumer hooks aborted. (Strict mode deferred to avoid frustrating iterative workflows in v1.)

## Post-hook failure behavior

Always advisory. pkglab logs the warning and continues. Exit code unaffected.

## on-error behavior

Best-effort, non-recursive. Fires when:
- Internal operation fails (install failed, restore failed)
- Pre-hook aborted the operation (stage = `pre-hook`)

Does NOT fire when:
- Post-hook fails (post-hooks are advisory, no cleanup needed)
- on-error itself fails (swallowed, logged)

## Integration Points

## pkglab add (src/commands/add.ts)

```
1. Resolve packages
2. Run pre-add hook (abort = exit non-zero, skip remaining steps)
3. addRegistryToNpmrc()
4. installWithVersionUpdates()
5. Save repo state
6. Run post-add hook (failure = warn)

On failure at step 3-5:
7. Run on-error hook (best-effort)
```

Pre-add fires before npmrc setup to keep abort semantics clean (no rollback needed). Hooks that need to verify registry connectivity can use `PKGLAB_REGISTRY_URL` to probe directly.

## pkglab restore (src/commands/restore.ts)

```
1. Determine packages to restore
2. Run pre-restore hook (abort = exit non-zero)
3. restorePackage() for each
4. Update repo state
5. Clean up npmrc if no packages left
6. Run pm install
7. Run post-restore hook (failure = warn)

On failure at step 3-6:
8. Run on-error hook (best-effort)
```

## pkglab pub consumer auto-update (src/commands/pub.ts)

Per-repo, inside the streaming consumer update callback:

```
1. Build version entries for this repo
2. Run pre-update hook (abort = skip repo, log, continue others)
3. installWithVersionUpdates()
4. Save repo state
5. Run post-update hook (failure = warn)

On failure at step 3-4:
6. Run on-error hook (best-effort)
```

Consumer updates already run with bounded concurrency. Hooks execute inline per-repo (no additional parallelism within a single repo's update).

## Hook Runner Module

New file: `src/lib/hooks.ts`

```typescript
export interface PkglabHookPayload {
  schemaVersion: 1;
  event: 'add' | 'restore' | 'update';
  phase: 'pre' | 'post' | 'error';
  packages: Array<{ name: string; version: string; previous?: string }>;
  tag: string | null;
  repoPath: string;
  registryUrl: string;
  packageManager: string;
  error: { stage: string; message: string; failedHook: string | null } | null;
}

type HookStatus = 'not_found' | 'ok' | 'failed' | 'aborted' | 'timed_out';

interface HookResult {
  status: HookStatus;
  exitCode?: number;
  durationMs: number;
}

// Internal executor: builds payload, spawns hook, handles timeout
async function executeHook(hookPath: string, payload: PkglabHookPayload, timeoutMs: number): Promise<HookResult>

// Typed wrappers for call sites
async function runPreHook(ctx: Omit<PkglabHookPayload, 'phase'>): Promise<HookResult>
async function runPostHook(ctx: Omit<PkglabHookPayload, 'phase'>): Promise<HookResult>
async function runErrorHook(ctx: Omit<PkglabHookPayload, 'phase'> & { error: NonNullable<PkglabHookPayload['error']> }): Promise<HookResult>
```

Single internal executor prevents behavior drift. Typed wrappers give safer call sites and clearer intent.

Execution by extension:
- `.ts`: `Bun.spawn(['bun', 'run', hookPath, jsonPayload], { cwd: repoPath })`
- `.sh`: `Bun.spawn(['bash', hookPath, jsonPayload], { cwd: repoPath })`
- (none): `Bun.spawn([hookPath, jsonPayload], { cwd: repoPath })`

All spawned without shell interpolation.

## Hook discovery (findHook)

```typescript
// Checks for hook file in priority order: .ts > .sh > extensionless
// Returns { path, runner } or null
function findHook(repoPath: string, eventName: string): { path: string; runner: 'bun' | 'bash' | 'direct' } | null
```

## CLI Output

## Default mode

```
$ pkglab add @clerk/nextjs
  ✓ pre-add hook (0.1s)
  ✓ @clerk/nextjs 0.0.0-pkglab.1234
  ✓ post-add hook (0.2s)
```

Hook abort:
```
$ pkglab add @clerk/nextjs
  ✗ pre-add hook failed (exit 1)
    "Cannot add packages: local API server not running"
  Aborted.
```

Pub fan-out:
```
Publishing @clerk/nextjs, @clerk/express...

  testbed-app:
    ✓ pre-update (0.2s)
    ✓ @clerk/nextjs, @clerk/express
    ✓ post-update (0.3s)

  other-app:
    ⚠ pre-update aborted (exit 1) — skipped
```

## Verbose mode (--verbose)

Shows hook stdout/stderr inline. Default mode only shows stderr on failure.

## pkglab hooks init

Scaffolds the full hooks directory:

1. Creates `.pkglab/hooks/`
2. Writes `payload.d.ts` with the `PkglabHookPayload` type definition
3. Creates all 7 hook files as `.ts` stubs (commented out, not active until uncommented):
   - `pre-add.ts`, `post-add.ts`
   - `pre-restore.ts`, `post-restore.ts`
   - `pre-update.ts`, `post-update.ts`
   - `on-error.ts`

Each stub contains only comments: the type import, a description of when it fires, and example usage code. Nothing runs until the user uncomments and edits.

Example generated stub (`post-add.ts`):
```typescript
// .pkglab/hooks/post-add.ts
// Runs after `pkglab add` installs packages in this repo.
//
// import type { PkglabHookPayload } from './payload';
// const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
//
// Example: set environment variables for local development
// const envFile = Bun.file('.env.local');
// await Bun.write(envFile, 'MY_VAR=local_value\n');
```

Example generated `payload.d.ts`:
```typescript
export interface PkglabHookPayload {
  schemaVersion: 1;
  event: 'add' | 'restore' | 'update';
  phase: 'pre' | 'post' | 'error';
  packages: Array<{ name: string; version: string; previous?: string }>;
  tag: string | null;
  repoPath: string;
  registryUrl: string;
  packageManager: string;
  error: { stage: string; message: string; failedHook: string | null } | null;
}
```

## Concrete Example: Clerk Testbed

Shell example (post-add):
```bash
#!/bin/bash
# .pkglab/hooks/post-add
# Point Clerk SDKs to local API when using local packages
# Payload available as $1 (JSON), use jq if needed

ENV_FILE=".env.local"
touch "$ENV_FILE"

# Upsert pattern: remove existing lines, then append
grep -v '^CLERK_API_URL=' "$ENV_FILE" | grep -v '^CLERK_BACKEND_API=' > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

echo "CLERK_API_URL=http://localhost:3100" >> "$ENV_FILE"
echo "CLERK_BACKEND_API=http://localhost:8080" >> "$ENV_FILE"
```

Shell example (post-restore):
```bash
#!/bin/bash
# .pkglab/hooks/post-restore
# Remove local API overrides when restoring production packages

ENV_FILE=".env.local"
[ -f "$ENV_FILE" ] || exit 0

grep -v '^CLERK_API_URL=' "$ENV_FILE" | grep -v '^CLERK_BACKEND_API=' > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
```

TypeScript example (post-update.ts):
```typescript
// .pkglab/hooks/post-update.ts
// Ensure local API is configured on auto-updates (idempotent)

import type { PkglabHookPayload } from './payload';

const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
console.log(`Updating env for ${payload.packages.length} packages`);

const envFile = Bun.file('.env.local');
const existing = await envFile.exists() ? await envFile.text() : '';

const cleaned = existing
  .split('\n')
  .filter(l => !l.startsWith('CLERK_API_URL=') && !l.startsWith('CLERK_BACKEND_API='))
  .join('\n');

const updated = cleaned.trimEnd() + '\n'
  + 'CLERK_API_URL=http://localhost:3100\n'
  + 'CLERK_BACKEND_API=http://localhost:8080\n';

await Bun.write('.env.local', updated);
```

## Workflow

```bash
# In the Clerk SDK workspace:
pkglab pub                    # publish local packages
# -> testbed-app auto-update fires
# -> post-update hook sets local API endpoints

# In testbed-app:
pkglab add @clerk/nextjs      # explicit add
# -> post-add hook sets local API endpoints

# Done testing:
pkglab restore --all          # restore original versions
# -> post-restore hook removes local API overrides
```

## Scope and Deferrals

In scope for v1:
- 7 hook events
- File-based discovery in `.pkglab/hooks/` with `.ts` > `.sh` > extensionless priority
- Single JSON payload via argv[1]
- `PkglabHookPayload` type via local `payload.d.ts` (generated by `pkglab hooks init`)
- `pkglab hooks init` scaffolds directory, types, and all 7 hook stubs (commented out)
- Timeout with `--hook-timeout` flag and `PKGLAB_HOOK_TIMEOUT_MS` env var
- Hook status in CLI output

Deferred:
- Windows support (`.cmd`/`.ps1` fallbacks)
- `.pkglab/hooks.local/` for uncommitted personal hooks
- `--strict-hooks` flag for CI (non-zero exit on any hook abort in pub)
- Batch-level hooks (`pre-update-all`/`post-update-all`)
- Per-event timeout configuration
- `pkglab hooks init --example clerk` opinionated templates
