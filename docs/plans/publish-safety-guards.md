# Publish Safety Guards (v2)

Ensure `pkglab pub` can never accidentally publish to the public npm registry. Even if code regresses, npm behaves unexpectedly, or the environment is contaminated, publishing to npmjs.org should be impossible.

## Motivation

pkglab publishes packages using `npm publish --registry http://127.0.0.1:{port}`. If that flag is ignored, the URL is malformed, or environment variables override it, packages could land on the real npm registry. This would be catastrophic for private/internal packages and could break public ones.

Current safeguards (explicit `--registry` flag, localhost-only binding, daemon check) are good but not sufficient for defense-in-depth.

## Failure Scenarios

- npm CLI ignores or mishandles the `--registry` flag due to a bug or version change
- `NPM_CONFIG_REGISTRY` or an `.npmrc` file overrides the explicit flag
- A code regression removes or misconstructs the registry URL (empty string, undefined, wrong port)
- Silent misdirection where publish "succeeds" but lands on the wrong registry

## Design

Four layers of protection, all in `publisher.ts`:

## Layer 1: Registry URL Validation

Before every publish call, assert the registry URL:

- Is not empty/undefined/null
- Matches `http://127.0.0.1:{port}` or `http://localhost:{port}`
- Port is a valid number

Throw immediately if any check fails. This catches code regressions.

```ts
function assertLocalRegistry(url: string): void {
  if (!url) throw new Error("Registry URL is empty");
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`Registry URL is not local: ${url}`);
  }
}
```

## Layer 2: Environment Sanitization

When spawning the `npm publish` subprocess, strip all npm config env vars to prevent overrides:

```ts
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("NPM_CONFIG_") && !key.startsWith("npm_config_"),
  ),
);
```

Pass this cleaned env to `Bun.spawn`. This prevents environment contamination.

## Layer 3: Verdaccio Identity Check

Before the first publish in a batch, hit the Verdaccio-specific endpoint to confirm the registry is actually Verdaccio:

```ts
const res = await fetch(`${registryUrl}/-/verdaccio/`);
if (!res.ok) throw new Error("Registry is not Verdaccio");
```

This catches scenarios where the port is occupied by something else.

## Layer 4: Post-Publish Verification

After each package publish, verify it landed on Verdaccio:

```ts
const res = await fetch(`${registryUrl}/${name}/${version}`);
if (!res.ok) throw new Error(`Package not found on Verdaccio after publish`);
```

Optionally, also verify it does NOT exist on the public registry at that version (the `0.0.0-pkglab.*` version scheme makes this unlikely but worth checking for paranoia).

## Estimated Effort

~40-60 lines of logic in `publisher.ts`. No new dependencies, no architectural changes.
