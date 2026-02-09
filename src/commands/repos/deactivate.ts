import { defineCommand } from "citty";
import { loadRepoState, saveRepoState } from "../../lib/repo-state";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "deactivate", description: "Deactivate repo" },
  args: {
    name: { type: "positional", description: "Repo name", required: true },
  },
  async run({ args }) {
    const name = args.name as string;
    const state = await loadRepoState(name);
    if (!state) {
      log.error(`Repo not found: ${name}`);
      process.exit(1);
    }

    state.active = false;
    await saveRepoState(name, state);
    log.success(`Deactivated ${name}`);
  },
});
