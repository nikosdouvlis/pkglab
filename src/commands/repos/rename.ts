import { defineCommand } from "citty";
import { loadRepoState } from "../../lib/repo-state";
import { paths } from "../../lib/paths";
import { join } from "node:path";
import { rename } from "node:fs/promises";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "rename", description: "Rename a repo alias" },
  args: {
    old: { type: "positional", description: "Current name", required: true },
    new_name: { type: "positional", description: "New name", required: true },
  },
  async run({ args }) {
    const oldName = args.old as string;
    const newName = args.new_name as string;

    const state = await loadRepoState(oldName);
    if (!state) {
      log.error(`Repo not found: ${oldName}`);
      process.exit(1);
    }

    await rename(
      join(paths.reposDir, `${oldName}.yaml`),
      join(paths.reposDir, `${newName}.yaml`)
    );
    log.success(`Renamed ${oldName} -> ${newName}`);
  },
});
