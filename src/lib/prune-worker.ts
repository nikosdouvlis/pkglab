import { pruneAll } from "./prune";

const port = Number(process.argv[2]);
const prune_keep = Number(process.argv[3]);
const tagArg = process.argv[4];

// When tag is passed from pub.ts, only prune that tag's group
// When no tag arg, prune all groups (manual `pkglab prune` or untagged pub)
const onlyTag = tagArg !== undefined ? tagArg : undefined;

await pruneAll({ port, prune_keep }, onlyTag).catch(() => {});
