import { defineCommand } from "citty";
import {
  loadRepoByPath,
  saveRepoByPath,
  getRepoDisplayName,
  canonicalRepoPath,
} from "../../lib/repo-state";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "off", description: "Deactivate repo" },
  args: {
    name: { type: "positional", description: "Repo path", required: false },
  },
  async run({ args }) {
    const pathArg = args.name as string | undefined;

    const paths = ((args as any)._ as string[] | undefined) ?? [];
    if (pathArg) paths.unshift(pathArg);

    if (paths.length === 0) {
      // Interactive mode: select from active repos
      const { selectRepos } = await import("../../lib/prompt");
      const selected = await selectRepos({
        message: "Select repos to deactivate",
        filter: (s) => s.active,
        emptyMessage: "No repos are currently active.",
      });

      if (selected.length === 0) return;

      for (const { displayName, state } of selected) {
        state.active = false;
        await saveRepoByPath(state.path, state);
        log.success(`Deactivated ${displayName}`);
      }

      return;
    }

    for (const p of paths) {
      const canonical = await canonicalRepoPath(p);
      const state = await loadRepoByPath(canonical);

      if (!state) {
        log.error(`Repo not found at path: ${p}`);
        process.exit(1);
      }

      state.active = false;
      await saveRepoByPath(state.path, state);
      const displayName = await getRepoDisplayName(state.path);
      log.success(`Deactivated ${displayName}`);
    }
  },
});
