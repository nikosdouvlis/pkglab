import { defineCommand } from "citty";
import { loadRepoState, saveRepoState, findRepoByPath, canonicalRepoPath } from "../../lib/repo-state";
import { addRegistryToNpmrc, applySkipWorktree } from "../../lib/consumer";
import { loadConfig } from "../../lib/config";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "on", description: "Activate repo for auto-updates" },
  args: {
    name: { type: "positional", description: "Repo name or path", required: false },
  },
  async run({ args }) {
    const name = args.name as string | undefined;
    const config = await loadConfig();

    // Helper function to activate a single repo
    const activateRepo = async (repoName: string) => {
      const state = await loadRepoState(repoName);
      if (!state) {
        log.error(`Repo not found: ${repoName}`);
        return false;
      }

      await addRegistryToNpmrc(state.path, config.port);
      await applySkipWorktree(state.path);

      state.active = true;
      state.lastUsed = Date.now();
      await saveRepoState(repoName, state);
      log.success(`Activated ${repoName}`);
      return true;
    };

    if (name) {
      // If name is provided, check if it's a path
      if (name.startsWith("/") || name.startsWith(".")) {
        // Resolve as a path
        const resolvedPath = await canonicalRepoPath(name);
        const repo = await findRepoByPath(resolvedPath);
        if (!repo) {
          log.error(`Repo not found at path: ${name}`);
          process.exit(1);
        }
        await activateRepo(repo.name);
      } else {
        // Treat as repo name
        const success = await activateRepo(name);
        if (!success) {
          process.exit(1);
        }
      }
    } else {
      // No name provided - show interactive picker for inactive repos
      const { selectRepos } = await import("../../lib/prompt");
      const selected = await selectRepos({
        message: "Select repos to activate",
        filter: (s) => !s.active,
        emptyMessage: "All repos are already active.",
      });

      if (selected.length === 0) return;

      // Activate each selected repo
      for (const repo of selected) {
        await activateRepo(repo.name);
      }
    }
  },
});
