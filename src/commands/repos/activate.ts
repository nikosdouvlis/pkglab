import { defineCommand } from "citty";
import { loadRepoState, saveRepoState } from "../../lib/repo-state";
import { addRegistryToNpmrc, applySkipWorktree } from "../../lib/consumer";
import { loadConfig } from "../../lib/config";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "activate", description: "Activate repo for auto-updates" },
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

    const config = await loadConfig();
    await addRegistryToNpmrc(state.path, config.port);
    await applySkipWorktree(state.path);

    state.active = true;
    await saveRepoState(name, state);
    log.success(`Activated ${name}`);
  },
});
