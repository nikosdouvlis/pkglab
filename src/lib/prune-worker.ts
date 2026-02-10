import { pruneAll } from "./prune";

const port = Number(process.argv[2]);
const prune_keep = Number(process.argv[3]);

await pruneAll({ port, prune_keep }).catch(() => {});
