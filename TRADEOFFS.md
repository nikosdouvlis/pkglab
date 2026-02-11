# Cascade Behavior Tradeoffs

This document explains the scoping decisions in `pkglab pub` and the tradeoffs they carry. It's meant to help future contributors (or the user six months from now) understand why the cascade works the way it does, and what the options are if different behavior is needed.

## How the cascade works

When you run `pkglab pub`, the algorithm builds a "cascade" of packages to include in the publish scope:

1. Pick targets. If you're in a package directory, the target is that package. If you pass a name, that's the target. From workspace root, all publishable packages become targets.
2. Pull in transitive dependencies of each target. This ensures workspace deps get published at matching pkglab versions, so internal `workspace:^` references resolve correctly against the local registry.
3. Compute transitive dependents of the targets only (not of dependencies pulled in during step 2).
4. If active consumer repos exist, filter dependents: only keep the ones that some consumer has installed via `pkglab add`.
5. Close under deps: every package in the final set must have its workspace deps also in the set. This is a fixpoint loop that can pull in additional packages.
6. Fingerprint everything in scope. Classify each package as changed (content hash differs), propagated (content same but a workspace dep changed), or unchanged (skip, keep existing version).
7. Publish changed and propagated packages. Skip unchanged ones.

## Scoped vs full cascade

The key design choice: dependents are computed for the original targets only, not for dependencies that get pulled in during step 2.

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
- Dependents of @clerk/nextjs: none (it's a leaf package)
- Final scope: those 4 packages
- @clerk/express and @clerk/remix are NOT in scope, even though they depend on @clerk/shared

Why this is the right default:

- Publishing from a package directory means "I'm iterating on this package." You don't need express and remix in scope when you're working on nextjs.
- The scope stays narrow, so `pkglab pub` is fast and predictable for the common iteration loop.
- If you want to cascade from @clerk/shared to all its dependents, you run `pkglab pub` from shared's directory or from workspace root. The tool follows the target you chose.

Where it can bite you:

- You edit @clerk/shared while working on @clerk/nextjs. You run `pkglab pub` from the nextjs directory. Shared gets published with the new code (it's a dependency of nextjs), but express and remix keep their old versions because they aren't dependents of the target.
- A consumer repo using both @clerk/nextjs and @clerk/express now has an inconsistency: nextjs sees the new shared, but express still sees the old shared. This can cause subtle version mismatches at runtime.
- The user has to know to also run `pkglab pub` from shared's directory (or workspace root) if they want all of shared's dependents updated.

Workarounds available today:

- Run `pkglab pub` from workspace root to get the full cascade (all publishable packages become targets, so all their dependents are included).
- Run `pkglab pub` from the dependency's directory (e.g. @clerk/shared) to cascade to all its dependents.
- Run `pkglab pub @clerk/shared` from anywhere to target a specific package by name.

## Consumer-aware filtering

When active consumer repos exist (repos where you've run `pkglab add`), the cascade filters dependents: only dependents that some consumer has installed are kept in scope. This avoids publishing packages nobody is using locally, which matters in large monorepos with dozens of publishable packages.

The tradeoff: if you later run `pkglab add @clerk/express` and express was previously filtered out of the cascade, you get a stale version until the next `pkglab pub`. The `add` command installs whatever version is currently in the local Verdaccio, and if express hasn't been published recently, that version could be outdated.

When no consumer repos are active at all, the filter is disabled and all dependents are included. This is the safe default for first-time users who haven't set up any consumers yet, but it does mean larger cascades in big monorepos.

## Possible improvements

If the current behavior causes friction, here are some directions to explore:

Two-phase cascade. Fingerprint the target and its dependencies first. Then expand dependents only from packages whose content actually changed (not from unchanged deps). Repeat to a fixpoint. In the example above, if you edit @clerk/shared while running from @clerk/nextjs, the first pass would detect that shared changed, then the second pass would pull in express and remix as dependents of shared. If shared is unchanged, no expansion happens and the scope stays narrow. This gives the best of both worlds but adds complexity to the cascade algorithm.

A flag like `--full` or `--deep`. Opt-in to expanding dependents from all packages in scope, not just the original targets. Simple to implement, keeps the default behavior predictable, puts the decision in the user's hands.

Better visibility into what was excluded. The scope summary already shows skipped unconsumed dependents, but it could also show dependents that were excluded by the scoping rule (not the consumer filter, but the "dependents of targets only" rule). This would help users understand when they need to widen their target.

A warning when a published dependency has dependents outside the scope. After fingerprinting, if a dependency was classified as changed and has dependents that aren't in the cascade, the tool could print a note like "shared changed but express/remix are not in scope, run from workspace root to include them." This is the least invasive option and doesn't change any behavior.
