import { defineCommand } from 'citty';

import type { RepoState } from '../../types';

import { getPositionalArgs } from '../../lib/args';
import { log } from '../../lib/log';
import {
  loadOperationalRepos,
  loadRepoByPath,
  saveRepoByPath,
  getRepoDisplayName,
  canonicalRepoPath,
} from '../../lib/repo-state';

export default defineCommand({
  meta: { name: 'off', description: 'Deactivate repo for auto-updates' },
  args: {
    name: { type: 'positional', description: 'Repo path', required: false },
    all: { type: 'boolean', description: 'Deactivate all repos', default: false },
  },
  async run({ args }) {
    const pathArg = args.name as string | undefined;

    const deactivateRepo = async (state: RepoState) => {
      state.active = false;
      await saveRepoByPath(state.path, state);
      const displayName = await getRepoDisplayName(state.path);
      log.success(`Deactivated ${displayName}`);
    };

    // --all: deactivate every known repo
    if (args.all) {
      const repos = await loadOperationalRepos();
      if (repos.length === 0) {
        log.info('No repos registered');
        return;
      }

      let deactivated = 0;
      for (const { state } of repos) {
        if (!state.active) {
          continue;
        }
        await deactivateRepo(state);
        deactivated++;
      }

      if (deactivated === 0) {
        log.info('No repos are currently active');
      }
      return;
    }

    const paths = getPositionalArgs(args);
    if (pathArg) {
      paths.unshift(pathArg);
    }

    if (paths.length === 0) {
      // Interactive mode: select from active repos
      const { selectRepos } = await import('../../lib/prompt');
      const selected = await selectRepos({
        message: 'Select repos to deactivate',
        filter: s => s.active,
        emptyMessage: 'No repos are currently active.',
      });

      if (selected.length === 0) {
        return;
      }

      for (const { state } of selected) {
        await deactivateRepo(state);
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

      await deactivateRepo(state);
    }
  },
});
