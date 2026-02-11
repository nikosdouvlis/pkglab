import { defineCommand } from "citty";
import {
  loadRepoState,
  saveRepoState,
  canonicalRepoPath,
  findRepoByPath,
} from "../../lib/repo-state";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "off", description: "Deactivate repo" },
  args: {
    name: { type: "positional", description: "Repo name or path", required: false },
  },
  async run({ args }) {
    const nameArg = args.name as string | undefined;

    if (!nameArg) {
      // Interactive mode: select from active repos
      const { selectRepos } = await import("../../lib/prompt");
      const selected = await selectRepos({
        message: "Select repos to deactivate",
        filter: (s) => s.active,
        emptyMessage: "No repos are currently active.",
      });

      if (selected.length === 0) return;

      for (const { name, state } of selected) {
        state.active = false;
        await saveRepoState(name, state);
        log.success(`Deactivated ${name}`);
      }

      return;
    }

    // Path-based resolution
    if (nameArg.startsWith("/") || nameArg.startsWith(".")) {
      const canonicalPath = await canonicalRepoPath(nameArg);
      const result = await findRepoByPath(canonicalPath);

      if (!result) {
        log.error(`Repo not found at path: ${nameArg}`);
        process.exit(1);
      }

      const { name, state } = result;
      state.active = false;
      await saveRepoState(name, state);
      log.success(`Deactivated ${name}`);
      return;
    }

    // Name-based resolution (original behavior)
    const state = await loadRepoState(nameArg);
    if (!state) {
      log.error(`Repo not found: ${nameArg}`);
      process.exit(1);
    }

    state.active = false;
    await saveRepoState(nameArg, state);
    log.success(`Deactivated ${nameArg}`);
  },
});
