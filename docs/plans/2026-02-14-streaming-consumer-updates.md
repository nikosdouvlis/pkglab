# Streaming Consumer Updates During Publish

## Problem

Currently, consumer repo updates wait for ALL packages to finish publishing before any consumer install starts. If a repo only needs 3 of 20 packages, it still waits for all 20.

## Design

**Current flow:**
```
publish ALL packages (parallel) -> set dist tags -> update ALL repos (parallel)
```

**New flow:**
```
publish packages (parallel) -> as each completes, check if any repo's
                                required set is fully published
                             -> if yes, start that repo's install immediately
                             -> after all publishes: set dist tags, save fingerprints
```

## Required Set Computation

For each consumer repo, the "required set" is the set of packages from the current publish batch that must be in the registry before the consumer's `bun install` can succeed.

1. Get the repo's direct packages (from repo state, filtered by tag)
2. For each direct package, get its transitive workspace deps from the dependency graph
3. Intersect with the current publish set (unchanged packages already exist in Verdaccio)

Example: repo has `@clerk/nextjs` via pkglab add. `@clerk/nextjs` transitively depends on `@clerk/shared` and `@clerk/backend`. All three are in the publish set, plus `@clerk/localizations` (unrelated). Required set = {nextjs, shared, backend}. Once those three publish, start the repo's install without waiting for localizations.

## Error Handling

No rollback. If a publish fails:
- Successfully published packages stay in the registry
- Consumer installs that already completed are fine (they installed valid versions)
- Consumer installs for repos that need the failed package never start
- The error is reported so the user can retry with `pkglab pub`

## Changes

`src/lib/publisher.ts` (executePublish):
- Remove rollback logic (successful publishes stay)
- Add `onPackagePublished(entry)` callback to PublishOptions
- Report failures without rolling back

`src/commands/pub.ts` (publishPackages):
- Accept workspace packages to build dependency graph
- Before publishing, compute required sets for each consumer repo
- Build unified spinner with publish lines + consumer repo lines
- On each successful publish, check if any repo's required set is complete
- Start consumer install immediately for ready repos

`src/lib/spinner.ts`:
- May need a way to update line text (for "waiting" -> "installing" transitions)

## Spinner Layout (interleaved)

All lines built upfront, updated in place:
```
  spinner @clerk/shared@version
  spinner @clerk/backend@version
  spinner @clerk/nextjs@version
  spinner @clerk/localizations@version
consumer-repo /path/to/repo              (header)
  spinner installing @clerk/nextjs, +2   (status line per repo)
other-repo /path/to/other                (header)
  dim     waiting for @clerk/localizations
```

## Data Flow

publishPackages needs:
- The dependency graph (from workspace packages, same as runCascade builds)
- The publish plan (already has this)
- Consumer repo work items (from buildConsumerWorkItems, move earlier)

The graph can be rebuilt cheaply from workspace.packages (buildDependencyGraph + precomputeTransitiveDeps). No need to thread it through from runCascade.
