# Publish Cascade Consistency

Date: 2026-02-11
Status: Phase 1, Phase 2, and Phase 3 implemented

## Problem

When publishing a package, pkglab cascades down (transitive deps) and up (transitive dependents). But dependents may have OTHER workspace deps ("sibling deps") that aren't in the publish set. This creates version mismatches in consumer apps.

Example: publishing `@clerk/react` cascades to `@clerk/nextjs` (dependent), but nextjs also depends on `@clerk/backend` which isn't published. The consumer ends up with two versions of `@clerk/shared` (one from the new publish via react, one from the old publish via backend).

```
Consumer dependency tree after publishing @clerk/react (before fix):

@clerk/nextjs@new
  +-- @clerk/react@new       -> @clerk/shared@new
  +-- @clerk/shared@new
  +-- @clerk/backend@old     -> @clerk/shared@old    <-- duplicate!
```

Two versions of the same package means duplicate module instances: singleton state isn't shared, instanceof checks fail, React contexts are invisible across versions.

## Root Causes

1. `computeCascade` didn't include workspace deps of dependents
2. `buildPublishPlan` resolved missing workspace deps to `*` (floating wildcard), letting Verdaccio resolve to arbitrary versions
3. Consumer installs ran one command per package, making wider cascades expensive

## Phase 1: Close Under Deps (Implemented)

Three changes that fix manifest consistency:

**Close cascade under deps** (graph.ts): After computing target + deps + dependents, a fixed-point loop ensures every publishable package in the closure has ALL its workspace deps also in the closure. Private packages are skipped to avoid dragging in unrelated sibling deps through non-publishable packages.

**Error on unresolved workspace edges** (publisher.ts): For runtime dep fields, if a dep uses workspace shorthand (`^`, `~`, `*`) and isn't in the publish set, throw an error instead of resolving to `*`. This is a safety net: the close-under-deps pass should make this unreachable, but it catches cascade bugs.

**Batch consumer installs** (consumer.ts, pm-detect.ts): Instead of `pnpm add pkg@v` N times per repo, batch into one `pnpm add pkg1@v1 pkg2@v2 ...` call. Reverts package.json on install failure for state consistency.

After phase 1, publishing `@clerk/react` produces 8 packages (adds `@clerk/backend`) instead of 7, and all share the same version. No duplicate instances in consumer apps for packages in the publish set.

## Why Not Connected Component? (Design Decision)

The first proposed fix was to publish the entire connected component of the dependency graph. If package A and B are connected through any chain of deps, publish them together. This guarantees no version mismatches anywhere.

For Clerk, since `@clerk/shared` is depended on by nearly everything, the connected component IS the entire monorepo. Publishing react would mean publishing all ~15 packages. The user pushed back: "I don't like that pub react -> pubs ALL because of shared."

Alternatives considered:

1. Connected component (rejected): correct but too broad. Publishing any package publishes everything in a connected monorepo.

2. Close under deps only (Phase 1): ensures every published package's workspace deps are in the set. Fixes the sibling dep problem (backend gets included). But all packages still get the same new version, including unchanged ones like shared, which cascades to everything anyway.

3. Version propagation without hashing (rejected): only bump the explicit target, propagate upward to dependents whose dep versions changed. Smart, but without content hashing we can't tell if shared actually changed. Either we always republish deps (back to "publish everything") or we never do (miss real changes).

4. Content-aware propagation (chosen, Phase 2): fingerprint each package, skip unchanged ones, only propagate through packages that actually changed. This is the only approach that is both correct (no duplicate instances) and targeted (doesn't publish unchanged packages). The cost is complexity: fingerprint state, topological processing, per-package version tracking.

The deciding insight: you can't avoid publishing hub dependencies without knowing whether they changed. Content fingerprinting is the enabler, not an optimization.

## Phase 2: Content-Aware Version Propagation (Implemented)

Phase 1 still publishes all packages at the same timestamp, including unchanged ones. Phase 2 eliminates unnecessary publishes by fingerprinting packages and only giving new versions to those that actually need them.

**Algorithm** (process in topological order):

1. Compute cascade as in phase 1 (target + deps + dependents, closed under deps)
2. For each package in topo order, fingerprint publish-relevant content
3. Compare fingerprint + resolved dep versions against stored state from previous publish
4. If UNCHANGED (same fingerprint, same dep versions): skip, reuse existing version
5. If CHANGED (different fingerprint OR a dep got a new version): publish with new timestamp

Trace for "react source changed, nothing else changed":

```
shared:     fingerprint same, no dep changes      -> SKIP, keep V1
react:      fingerprint changed                    -> PUBLISH V2 (manifest: shared@V1)
backend:    fingerprint same, dep shared@V1 same   -> SKIP, keep V1
nextjs:     fingerprint same, dep react V1->V2     -> PUBLISH V2 (react@V2, shared@V1, backend@V1)
chrome-ext: same as nextjs                         -> PUBLISH V2
```

Consumer result: `nextjs@V2 -> react@V2 + shared@V1 + backend@V1 -> shared@V1`. One version of shared.

**Fingerprinting approach**: `npm pack --dry-run --json` to get the file list (respects package.json "files", .npmignore, etc.), then hash file contents with `Bun.CryptoHasher` (SHA-256). ~150ms per package, no extra dependencies.

**State storage**: Store fingerprints per package per tag in `~/.pkglab/`. Treat as cache, not source of truth. Missing or mismatched state triggers a republish.

**Key design decisions**:

- Fingerprint the publish artifact (pack-equivalent), not the source tree
- Per-tag version tracking (reuse existing version must resolve within active tag channel)
- Process in topological order (each topo layer can be parallel)
- Per-package versions in manifests (changed packages reference the new version for changed deps, existing version for unchanged deps)

## Phase 3: Consumer-Aware Filtering (Implemented)

When active consumer repos exist, the cascade skips dependents that no consumer has installed (via `pkglab add`). This avoids publishing packages nobody is currently using.

How it works: `computeCascade` accepts an optional `consumedPackages` set (all package names across active repos). When provided, dependents are filtered: only those in the consumed set (or already in the closure as targets/deps) are included. Close-under-deps still runs after filtering, so deps of consumed dependents are pulled in correctly.

If no active repos exist, no filtering happens (all dependents are included as before).

Trade-off: `pkglab add` of a previously-skipped package gives a stale version until the next `pkglab pub`.

## Design Discussion Notes

This design was developed through a three-way brainstorming session (Claude Code + Codex gpt-5.3-codex, challenger mode). Key challenges from Codex that shaped the design:

- "Close under deps" alone is a partial fix without content fingerprinting, because unchanged hub deps still get new versions that propagate everywhere
- Fingerprint must be the publish artifact, not raw source tree (generated files, packlist rules)
- Stored fingerprints are a cache with fallback to republish on mismatch
- `npm publish` should use `--tag` directly instead of publishing to `latest` first (prevents cross-tag pollution)
- Batch consumer installs need rollback on failure for state consistency
