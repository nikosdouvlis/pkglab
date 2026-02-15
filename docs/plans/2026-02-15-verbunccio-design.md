# Verbunccio: Minimal Bun.serve() npm Registry

## Problem

pkglab embeds Verdaccio as its local npm registry. Verdaccio is a full-featured registry with auth, uplinks, plugins, web UI, and search. pkglab uses almost none of that. The cost:

- Cold start takes 2-5 seconds (plugin/uplink init, YAML config parsing, Express middleware stack)
- Verdaccio is a heavy dependency (~40MB installed, pulls in Express, lodash, etc.)
- Storage reads are expensive: Verdaccio stores all versions (upstream + pkglab) in a single packument. For example, `@clerk/shared/package.json` is ~21.6 MB with 4,012 versions, only 1 of which is a pkglab version. Every `getDistTags()` call parses the entire file (~26ms per call)
- No control over the wire protocol, debugging publish/install issues requires digging through Verdaccio internals

Verbunccio is a purpose-built Bun.serve() registry that handles only what pkglab needs.

## Architecture

Single-file Bun HTTP server running as a daemon subprocess (same lifecycle as Verdaccio today). In-memory packument index with write-through persistence to disk. No auth, no plugins.

Components:

- `verbunccio-worker.ts`: Bun.serve() entry point, request routing, ready signal
- `verbunccio-storage.ts`: in-memory index, disk persistence, tarball I/O
- `verbunccio-routes.ts`: route handlers for each endpoint

The worker starts Bun.serve(), loads all packuments into memory, then writes "READY\n" to stdout (same signal the daemon expects).

## Storage

Reuse the existing Verdaccio storage directory (`~/.pkglab/verdaccio/storage/`) so there's zero migration. The format is already what we need:

```
~/.pkglab/verdaccio/storage/
  @scope/
    name/
      package.json          # packument (all versions, dist-tags, _rev)
      name-0.0.0-pkglab.1234567890.tgz
  unscoped-name/
    package.json
    unscoped-name-0.0.0-pkglab.1234567890.tgz
```

Add neutral path aliases in `paths.ts` (`registryStorage` pointing to `verdaccioStorage`) so a future storage move only changes one line.

IMPORTANT: Load existing Verdaccio packuments as-is. Do NOT strip non-pkglab versions. Existing packuments may contain upstream versions that consumer lockfiles reference. Stripping them would break resolution. The `/-/pkglab/index` endpoint filters to pkglab-only data for CLI operations, but the full packument served via `GET /:pkg` must include all versions.

## In-Memory State

On boot, scan the storage directory and load all `package.json` packuments into memory. Note: existing Verdaccio storage may contain large packuments (e.g., 21 MB for `@clerk/shared`). Boot time depends on storage size, measure with real data.

In-memory maps:

- `packuments: Map<string, PackumentDoc>` (the canonical state)
- `fullJsonCache: Map<string, string>` (pre-serialized full packument responses)

No abbreviated packument cache in v1. Serve full packuments for all clients regardless of `Accept` header. This avoids compatibility issues across npm/pnpm/yarn/bun. Optimize later once correctness is proven.

Caches are invalidated on any mutation to that package.

## Write-Through Persistence

Every mutation (publish, unpublish, dist-tag update) writes to disk synchronously before returning. No debounce, no batching. Publish frequency is low enough that this is fine.

Write order for publish:

1. Decode base64 tarball from `_attachments`
2. Write tarball to temp file
3. Rename temp tarball to final path (atomic)
4. Strip `_attachments[*].data` from packument before writing (saves disk space, prevents stale base64 blobs)
5. Write packument to temp file
6. Rename temp packument to final path (atomic)
7. Update in-memory maps and invalidate caches

On boot, clean up `*.tmp` files left by crashes.

## Upstream Proxy

pkglab sets `registry=http://127.0.0.1:<port>` globally in consumer repo `.npmrc`. This means ALL package resolution (not just pkglab packages) goes through the local registry while pkglab packages are active. Verbunccio must handle requests for packages it doesn't have locally.

Proxy behavior by method and local state:

- `GET/HEAD /:pkg` (packument): if local, serve from memory. If not local, proxy to `https://registry.npmjs.org`.
- `GET/HEAD /:pkg/-/:file.tgz` (tarball): if local file exists, serve from disk. If not, proxy to npmjs.org.
- `PUT /:pkg` (publish): always handle locally. Never proxy mutations.
- `DELETE /:pkg/-rev/:rev` (unpublish): always handle locally. Never proxy mutations.
- `PUT /:pkg/-rev/:rev` (update packument): always handle locally.
- `PUT /-/package/:pkg/dist-tags/:tag` (set dist-tag): always handle locally.
- All `/-/` system paths: handle locally (stubs or real handlers).

Proxy implementation:

```ts
async function proxyToUpstream(req: Request, pathname: string): Promise<Response> {
  const upstream = new URL(pathname, 'https://registry.npmjs.org');
  const headers = new Headers(req.headers);
  // Strip local auth token before forwarding
  headers.delete('authorization');
  const resp = await fetch(upstream.toString(), {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  return new Response(resp.body, {
    status: resp.status,
    headers: resp.headers,
  });
}
```

No caching of upstream responses. The PM's own cache handles that.

On upstream failure (network error, timeout): return `502 { "error": "bad_gateway", "reason": "upstream registry unavailable" }`.

## HTTP Endpoints

All responses use `Content-Type: application/json` unless noted.

## PUT /:pkg (publish)

Receives the npm publish document from `bun publish`.

Request body:

```json
{
  "_id": "@scope/name",
  "name": "@scope/name",
  "dist-tags": { "pkglab": "0.0.0-pkglab.1234567890" },
  "versions": {
    "0.0.0-pkglab.1234567890": {
      "name": "@scope/name",
      "version": "0.0.0-pkglab.1234567890",
      "dependencies": {},
      "dist": {
        "shasum": "...",
        "integrity": "sha512-...",
        "tarball": "http://127.0.0.1:16180/@scope/name/-/name-0.0.0-pkglab.1234567890.tgz"
      }
    }
  },
  "_attachments": {
    "name-0.0.0-pkglab.1234567890.tgz": {
      "content_type": "application/octet-stream",
      "data": "<base64>",
      "length": 12345
    }
  }
}
```

Handler:

- Parse body, extract `_attachments`
- Decode base64 tarball, write to disk
- Merge new version into existing packument (or create new)
- Rewrite `dist.tarball` to canonical local URL: `http://127.0.0.1:${port}/${pkgName}/-/${filename}`
- Merge `dist-tags`
- Bump `_rev` (monotonic integer, format: `"${n}-verbunccio"`)
- Add `time[version]` entry
- Strip `_attachments[*].data` before persisting packument to disk
- Persist packument to disk
- Update in-memory state

Response: `201 { "ok": true, "id": "<pkg>", "rev": "<newRev>" }`

On duplicate version: `409 { "error": "conflict", "reason": "version already exists" }`

## GET /:pkg (packument)

Serve full packument from memory (no abbreviated form in v1).

If package exists locally: `200` with packument JSON.
If not local: proxy to upstream (see Upstream Proxy section).

## GET /:pkg/-/:filename.tgz (tarball)

Stream the tarball file from disk using `Bun.file()`.

If local file exists: `200` with `Content-Type: application/octet-stream`.
If not local: proxy to upstream.

Also supports `HEAD` for the same path.

## DELETE /:pkg/-rev/:rev (unpublish package)

Delete entire package and all its tarballs. Server owns all cleanup (no client-side `rm -rf`).

Handler:

- Check `_rev` matches current (if not, `409`)
- Remove package directory from disk (`rm -rf`)
- Remove from in-memory state
- Clean up empty scope directory if scoped

Response: `200 { "ok": true }` or `404`.

## PUT /:pkg/-rev/:rev (update packument)

Replace the packument. Used by `unpublishVersions()` to remove specific versions.

Handler:

- Check `_rev` matches current (if not, `409`)
- Replace packument in memory and on disk
- Bump `_rev`
- Delete tarballs for any removed versions (orphan cleanup)

Response: `201 { "ok": true, "id": "<pkg>", "rev": "<newRev>" }` or `404`.

## PUT /-/package/:pkg/dist-tags/:tag (set dist-tag)

Body: JSON string with the version, e.g. `"0.0.0-pkglab.1234567890"`

Handler:

- Verify the version exists in the packument
- Set the dist-tag
- Persist and update in-memory state

Response: `201 { "ok": true }` or `404`.

## GET /-/pkglab/index (custom, for CLI)

Returns a compact index of all packages for CLI operations (pkg ls, pkg rm, add picker, prune, cascade version checks). Only includes pkglab versions (filtered from full packuments).

Response:

```json
{
  "packages": {
    "@scope/name": {
      "rev": "12-verbunccio",
      "dist-tags": { "pkglab": "0.0.0-pkglab.1234567890" },
      "versions": ["0.0.0-pkglab.1234567890", "0.0.0-pkglab.1234567889"]
    }
  }
}
```

This replaces all filesystem reads in `registry.ts` with a single HTTP call. The performance case for HTTP over direct filesystem reads: Verdaccio packuments contain all versions (upstream + pkglab). Parsing a 21 MB packument to find one pkglab version costs ~26ms per call. The in-memory index is pre-filtered to pkglab-only data and pre-serialized, so the HTTP path (including localhost TCP overhead) is sub-2ms. The CLI should memoize one index fetch per invocation and invalidate after mutations.

## Compatibility Stubs

Package managers send requests Verbunccio doesn't need to handle meaningfully, but must respond to:

- `GET /-/ping`: return `200 {}` (used by `pkglab doctor` and npm health checks)
- `POST /-/npm/v1/security/advisories/bulk`: return `200 {}` (npm/bun audit during install)
- `POST /-/npm/v1/security/audits/quick`: return `200 {}` (npm/bun audit during install)

## GET /-/ready (health check)

Response: `200 { "ok": true }`

Used for health checks, debugging, and tests. The daemon startup handshake still uses stdout "READY\n" (faster for parent-child sync).

## Path Parsing

Scoped package names arrive in two forms:

- `bun publish` sends `PUT /@scope%2Fname` (URL-encoded slash)
- `bun install` sends `GET /@scope/name` (decoded slash)

Routing strategy:

1. Get raw pathname from URL
2. Route `/-/` prefixed paths first (dist-tags, pkglab index, ready, ping, audit stubs)
3. For package paths, split at first `/-/` to separate package name from tarball filename
4. Run `decodeURIComponent` on the package name segment to normalize both forms
5. Validate package name: reject path traversal (`..`), double-encoded names, malformed percent-encoding

## Concurrent Publish Handling

pkglab runs `Promise.allSettled` to publish multiple packages in parallel. Multiple `bun publish` processes hit the registry simultaneously.

Per-package mutex using a Promise chain:

```ts
const locks = new Map<string, Promise<void>>();

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  locks.set(name, next);
  await prev;
  try {
    return await fn();
  } finally {
    resolve!();
    if (locks.get(name) === next) locks.delete(name);
  }
}
```

All mutating routes (publish, update packument, delete, set dist-tag) acquire the lock by package name. Different packages publish in parallel. Read routes (GET packument, GET tarball) never lock.

Client-side: add retry on `409` in `unpublishVersions()` and `removePackage()` (refetch latest doc/rev, reapply mutation, retry 2-3 times).

## Integration Changes

## New Files

- `src/lib/verbunccio-worker.ts`: Bun.serve() entry point
  - Loads storage into memory
  - Starts server on configured port/host
  - Writes "READY\n" to stdout
  - Routes requests to handlers
  - Proxy fallback for unknown packages

- `src/lib/verbunccio-storage.ts`: storage layer
  - `loadAll()`: scan storage dir, load all packuments into memory
  - `getPackument(name)`, `getFullJson(name)`
  - `hasPackage(name)`: check if package exists locally (for proxy decision)
  - `savePackument(name, doc)`: atomic write-through
  - `saveTarball(name, filename, data)`: atomic write
  - `deletePackage(name)`: remove dir and in-memory state
  - `deleteTarball(name, filename)`
  - `getIndex()`: return compact pkglab-only index for `/-/pkglab/index`
  - `withLock(name, fn)`: per-package mutex

- `src/lib/verbunccio-routes.ts`: route handlers
  - `handlePublish(req, storage, port)`
  - `handleGetPackument(req, storage)`
  - `handleGetTarball(req, storage)`
  - `handleDeletePackage(req, storage)`
  - `handleUpdatePackument(req, storage)`
  - `handleSetDistTag(req, storage)`
  - `handleGetIndex(storage)`
  - `proxyToUpstream(req, pathname)`: transparent proxy for unknown packages

## Modified Files

- `src/index.ts`: in `--__worker` block, check env var to pick worker
  ```ts
  if (process.env.PKGLAB_VERBUNCCIO === '1') {
    const { main } = await import('./lib/verbunccio-worker');
    await main();
  } else {
    const { main } = await import('./lib/verdaccio-worker');
    await main();
  }
  ```
  Also update meta description from "Local package development with Verdaccio" to "Local package development CLI"

- `src/lib/paths.ts`: add `registryStorage` alias pointing to `verdaccioStorage`

- `src/lib/registry.ts`: when Verbunccio is active, switch from filesystem reads to HTTP
  - `listPackageNames()`: call `GET /-/pkglab/index`
  - `listAllPackages()`: call `GET /-/pkglab/index`
  - `getDistTags()`: call `GET /-/pkglab/index`
  - `removePackage()`: HTTP DELETE only, remove client-side `rm -rf` (server owns cleanup)
  - `unpublishVersions()`: keep HTTP flow, add `409` retry logic
  - `setDistTag()`: check `resp.ok`, surface errors
  - Detect active backend via PID file `backend` field

- `src/lib/daemon.ts`:
  - Update error messages from "Verdaccio" to "registry"
  - Store `backend: "verbunccio" | "verdaccio"` in PID file
  - Update `validatePid()` to match both "verdaccio-worker" and "verbunccio-worker" process names

- `src/lib/prune.ts`: switch `listAllPackages()` to use HTTP index when available (prune subprocess is detached, needs port info from argv)

- `src/lib/verdaccio-config.ts`: no changes (still used when Verdaccio is active)

## What Verdaccio Does That We Skip

- Auth (htpasswd, token validation): localhost only, no auth needed
- Plugin system: no plugins
- Web UI: no browser interface
- Search API (`/-/v1/search`): not used by pkglab
- YAML config parsing: hardcoded config in code
- Express middleware stack: raw Bun.serve() fetch handler
- Rate limiting: localhost, not needed
- Package access control: everything is public

What we keep (that the original design skipped):
- Upstream proxy: transparent pass-through for unknown packages (required because `.npmrc` is global)
- Audit stubs: empty responses to prevent PM errors
- Ping endpoint: for doctor compatibility

## Benchmark Plan

New file: `benchmarks/registry-benchmark.ts`

Automated benchmark script that runs both backends under identical conditions and produces a comparison table.

## Fixture Setup

Create a temporary workspace with a fixture package:

```
/tmp/pkglab-bench/
  workspace/
    package.json          # { "name": "bench-workspace", "workspaces": ["packages/*"] }
    packages/
      bench-pkg/
        package.json      # { "name": "@bench/pkg", "version": "1.0.0", "files": ["dist"] }
        dist/
          index.js        # ~50KB of generated code (realistic tarball size)
          index.d.ts
  consumer/
    package.json          # { "name": "bench-consumer", "dependencies": { "@bench/pkg": "..." } }
```

The script creates this fresh each run. The fixture package should be ~50KB to represent a typical library tarball.

## Metrics

For each backend (verdaccio, verbunccio), measure:

1. Cold start: time from spawning the daemon to "READY" signal
   - `pkglab down` first, then `PKGLAB_VERBUNCCIO={0|1} pkglab up`
   - Measure with `performance.now()` around the daemon start call
   - Run 10 times, report p50/p95/min/max

2. Publish latency: time for `bun publish` of the fixture package
   - Unique version per run (timestamp-based)
   - Measure wall clock of the publish subprocess
   - Run 20 times, discard first 3 as warmup

3. Install latency: clean install in the consumer repo
   - `rm -rf node_modules bun.lock*` before each run
   - `bun install` with the registry pointing to localhost
   - Run 20 times, discard first 3 as warmup

4. Packument fetch latency: direct HTTP GET for the package metadata
   - `fetch('http://127.0.0.1:<port>/@bench/pkg')` with timing
   - Also measure with 10, 50, 100 versions published (version accumulation test)
   - Run 50 times per version count

5. Proxy latency: fetch a package that only exists on npmjs.org
   - `fetch('http://127.0.0.1:<port>/lodash')` (forces upstream proxy)
   - Compare: Verbunccio proxy vs Verdaccio uplink
   - Run 20 times

6. Memory (RSS): read from `ps -o rss= -p <pid>`
   - At idle (just after startup)
   - After 10 publish cycles
   - After 50 publish cycles
   - After 10 install cycles (with proxy traffic)

7. Concurrent publish throughput: publish 20 packages simultaneously
   - `Promise.allSettled` with 20 unique packages
   - Measure total wall clock and per-package latency
   - Compare serialization overhead from per-package mutex

8. Monorepo publish (realistic): simulate a JS monorepo publish cycle
   - Create 15 fixture packages with interdependencies (like a real monorepo: shared, types, core, react, express, etc.)
   - Publish all via `pkglab pub` (which uses cascade, fingerprinting, parallel publish)
   - Measure total wall clock for the full publish cycle
   - Run 5 times per backend

9. Memory over time: track RSS growth during sustained use
   - Publish 15 packages, then re-publish 10 times (simulating iterative development)
   - Sample RSS every 5 seconds during the run
   - Report peak RSS and RSS at end

## Script Structure

```ts
// benchmarks/registry-benchmark.ts

interface BenchResult {
  metric: string;
  verdaccio: { p50: number; p95: number; min: number; max: number };
  verbunccio: { p50: number; p95: number; min: number; max: number };
  unit: string;
}

async function main() {
  // 1. Create fixture workspace and consumer
  // 2. For each backend:
  //    a. Set env var
  //    b. pkglab down (clean slate)
  //    c. pkglab up (measure cold start)
  //    d. Run publish benchmark
  //    e. Run install benchmark
  //    f. Run packument fetch benchmark
  //    g. Run proxy benchmark
  //    h. Measure memory
  //    i. Run concurrent publish benchmark
  //    j. pkglab down
  // 3. Print comparison table
  // 4. Clean up fixture
}
```

## Output Format

Print a markdown table to stdout:

```
Registry Benchmark Results
--------------------------

| Metric                  | Verdaccio (p50) | Verbunccio (p50) | Delta    |
|-------------------------|-----------------|------------------|----------|
| Cold start              | 2,340ms         | 45ms             | -98%     |
| Publish (single)        | 120ms           | 35ms             | -71%     |
| Install (clean)         | 1,890ms         | 1,870ms          | -1%      |
| Packument GET (10 ver)  | 8ms             | 0.3ms            | -96%     |
| Packument GET (100 ver) | 26ms            | 0.5ms            | -98%     |
| Proxy GET (lodash)      | 180ms           | 190ms            | +6%      |
| Memory idle (RSS)       | 82MB            | 12MB             | -85%     |
| Memory after 50 pub     | 95MB            | 15MB             | -84%     |
| Concurrent 20 pub       | 3,200ms         | 850ms            | -73%     |
```

Also write raw JSON results to `benchmarks/results-{timestamp}.json` for later analysis.

## Running

```bash
# Full benchmark (both backends)
bun run benchmarks/registry-benchmark.ts

# Single backend only (for quick checks)
bun run benchmarks/registry-benchmark.ts --backend verbunccio
```

## Expected Results

- Cold start: sub-100ms Verbunccio vs 2-5s Verdaccio (biggest win)
- Publish: lower latency from skipping Express middleware and auth
- Memory: significantly lower RSS (no Express, no Verdaccio runtime, no YAML parser)
- Install: roughly the same (bottleneck is dependency resolution and node_modules layout, not registry response). For non-pkglab packages, both backends forward to npmjs.org. The PM caches everything on its side regardless.
- Packument GET: massive win for accumulated versions (in-memory pre-serialized vs disk parse). Bonus: Verbunccio doesn't cache upstream packuments to disk, which avoids the bloated-packument problem Verdaccio creates over time.
- Monorepo publish: should see a meaningful win since publish is called many times in quick succession, and Verbunccio skips Express middleware overhead on every request

## File Summary

New files:
- `src/lib/verbunccio-worker.ts`
- `src/lib/verbunccio-storage.ts`
- `src/lib/verbunccio-routes.ts`

Modified files:
- `src/index.ts`
- `src/lib/paths.ts`
- `src/lib/registry.ts`
- `src/lib/daemon.ts`
- `src/lib/prune.ts`

Removed after full cutover (not in v1):
- `src/lib/verdaccio-worker.ts`
- `src/lib/verdaccio-config.ts`
- `verdaccio` dependency in `package.json`
