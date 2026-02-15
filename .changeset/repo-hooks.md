---
'pkglab': minor
---

Add per-repo lifecycle hooks system. Consumer repos can place executable scripts in `.pkglab/hooks/` to run custom logic at key moments: before/after add, restore, and publish-triggered updates. Hooks receive a typed JSON payload as argv[1] with package details, registry URL, and event info. Includes `pkglab hooks init` to scaffold the hooks directory with type definitions and example stubs.
