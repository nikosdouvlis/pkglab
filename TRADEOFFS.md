# Cascade Behavior Tradeoffs

This document explains the scoping decisions in `pkglab pub` and the tradeoffs they carry. It's meant to help future contributors (or the user six months from now) understand why the cascade works the way it does, and what the options are if different behavior is needed.

## How the cascade works

When you run `pkglab pub`, the algorithm builds a "cascade" of packages to include in the publish scope:

1. Pick targets. If you're in a package directory, the target is that package. If you pass a name, that's the target. From workspace root, all publishable packages become targets.
2. Pull in transitive dependencies of each target. This ensures workspace deps get published at matching pkglab versions, so internal `workspace:^` references resolve correctly against the local registry.
3. Fingerprint the current scope. Classify each package as changed (content hash differs), propagated (content same but a workspace dep changed), or unchanged (skip, keep existing version).
4. Expand dependents only from packages classified as changed (not propagated or unchanged). Propagated packages don't need expansion because their dependents are already transitive dependents of the original changed package.
5. If active consumer repos exist, filter dependents: only keep the ones that some consumer has installed via `pkglab add`.
6. Close under deps: every package in the final set must have its workspace deps also in the set.
7. Repeat steps 3-6 until no new packages are added (fixpoint).
8. Publish changed and propagated packages. Skip unchanged ones.

## Scoped cascade with two-phase expansion

The cascade uses a two-phase approach: fingerprint first, then expand dependents only from packages that actually changed. This keeps the scope narrow when nothing upstream changed, but automatically widens it when a shared dependency was modified.

Here's a concrete example. Imagine this workspace:

```
@clerk/shared
  ├── @clerk/backend ── @clerk/nextjs
  ├── @clerk/react ──── @clerk/nextjs
  ├── @clerk/express
  └── @clerk/remix
```

Running `pkglab pub` from the @clerk/nextjs directory:

- Target: @clerk/nextjs
- Dependencies pulled in: @clerk/shared, @clerk/backend, @clerk/react
- Fingerprinting classifies each package

If @clerk/shared is unchanged, the scope stays at those 4 packages. Express and remix are not pulled in because shared kept its old version, so nothing downstream needs updating. This is the common case when you're iterating on a leaf package.

If @clerk/shared changed (you edited it while working on nextjs), the second phase kicks in: dependents of shared are expanded. Express and remix get pulled into scope, fingerprinted, and published with propagated versions. A consumer repo using both nextjs and express now sees a consistent version of shared everywhere.

Previously, dependents were only computed for the original targets (nextjs in this case), not for dependencies pulled in during the first phase. This meant editing shared while publishing from nextjs would leave express and remix on stale versions, causing version mismatches. The two-phase approach fixes this by letting fingerprint results drive the expansion.

You can still control the scope explicitly:

- Run `pkglab pub` from workspace root to target all publishable packages.
- Run `pkglab pub @clerk/shared` from anywhere to target a specific package by name.
- Run `pkglab pub` from a package directory to target that package (and the two-phase cascade handles the rest).

## Consumer-aware filtering

When active consumer repos exist (repos where you've run `pkglab add`), the cascade filters dependents: only dependents that some consumer has installed are kept in scope. This avoids publishing packages nobody is using locally, which matters in large monorepos with dozens of publishable packages.

The tradeoff: if you later run `pkglab add @clerk/express` and express was previously filtered out of the cascade, you get a stale version until the next `pkglab pub`. The `add` command installs whatever version is currently in the local registry, and if express hasn't been published recently, that version could be outdated.

When no consumer repos are active at all, the consumed set is empty, so the filter removes all dependents. The result is the same as `--shallow` (targets + deps only), but for a different reason: nobody is consuming anything yet. Once you run `pkglab add` in a consumer repo, the cascade starts expanding dependents (filtered to consumed packages).

`--shallow` explicitly skips the UP step (dependent expansion). Use it when you want a quick publish of just the target and its deps, regardless of whether consumer repos exist.

## Possible improvements

The two-phase cascade (described above) addresses the main scoping issue: dependents of changed dependencies are now automatically pulled in. The warning about changed deps with out-of-scope dependents is also no longer needed, since those dependents get expanded automatically.

If the current behavior still causes friction, here are some remaining directions:

A flag like `--full` or `--deep`. Opt-in to expanding dependents from all packages in scope, regardless of whether they changed. Could be useful if you want to force a full cascade without using `--force` (which also disables fingerprint skipping). Low priority now that the two-phase cascade handles the common case.

Better visibility into what was excluded. The scope summary shows skipped unconsumed dependents (consumer filter), but it could also surface cases where the two-phase loop decided not to expand (because a dependency was unchanged). This would help users understand why a package they expected to see isn't in the publish set.
