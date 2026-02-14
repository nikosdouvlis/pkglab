import { defineCommand } from "citty";
import {
  loadAllRepos,
  loadRepoByPath,
  saveRepoByPath,
  getRepoDisplayName,
  canonicalRepoPath,
} from "../../lib/repo-state";
import { addRegistryToNpmrc, applySkipWorktree } from "../../lib/consumer";
import { loadConfig } from "../../lib/config";
import { getPositionalArgs } from "../../lib/args";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "on", description: "Activate repo for auto-updates" },
  args: {
    name: { type: "positional", description: "Repo path", required: false },
    all: { type: "boolean", description: "Activate all repos", default: false },
  },
  async run({ args }) {
    const pathArg = args.name as string | undefined;
    const config = await loadConfig();

    const activateRepo = async (repoPath: string) => {
      const canonical = await canonicalRepoPath(repoPath);
      const state = await loadRepoByPath(canonical);
      if (!state) {
        log.error(`Repo not found at path: ${repoPath}`);
        return false;
      }

      await addRegistryToNpmrc(state.path, config.port);
      await applySkipWorktree(state.path);

      state.active = true;
      state.lastUsed = Date.now();
      await saveRepoByPath(state.path, state);
      const displayName = await getRepoDisplayName(state.path);
      log.success(`Activated ${displayName}`);
      return true;
    };

    // --all: activate every known repo
    if (args.all) {
      const repos = await loadAllRepos();
      if (repos.length === 0) {
        log.info("No repos registered");
        return;
      }

      let activated = 0;
      for (const { state } of repos) {
        if (state.active) continue;
        await addRegistryToNpmrc(state.path, config.port);
        await applySkipWorktree(state.path);
        state.active = true;
        state.lastUsed = Date.now();
        await saveRepoByPath(state.path, state);
        const displayName = await getRepoDisplayName(state.path);
        log.success(`Activated ${displayName}`);
        activated++;
      }

      if (activated === 0) {
        log.info("All repos are already active");
      }
      return;
    }

    const paths = getPositionalArgs(args);
    if (pathArg) paths.unshift(pathArg);

    if (paths.length > 0) {
      for (const p of paths) {
        const success = await activateRepo(p);
        if (!success) process.exit(1);
      }
    } else {
      // No arg provided, show interactive picker for inactive repos
      const { selectRepos } = await import("../../lib/prompt");
      const selected = await selectRepos({
        message: "Select repos to activate",
        filter: (s) => !s.active,
        emptyMessage: "All repos are already active.",
      });

      if (selected.length === 0) return;

      for (const { state } of selected) {
        await activateRepo(state.path);
      }
    }
  },
});
