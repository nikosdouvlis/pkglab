import { defineCommand } from 'citty';

import { c } from '../lib/color';
import { removeRegistryFromNpmrc, removePreCommitHook, removeSkipWorktree, restorePackage } from '../lib/consumer';
import { stopDaemon, getDaemonStatus } from '../lib/daemon';
import { stopListener, getListenerDaemonStatus } from '../lib/listener-daemon';
import { log } from '../lib/log';
import { runInstall } from '../lib/pm-detect';
import { loadAllRepos, saveRepoByPath } from '../lib/repo-state';
import { discoverWorkspace } from '../lib/workspace';

export default defineCommand({
  meta: { name: 'down', description: 'Stop pkglab services' },
  args: {
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Skip consumer restoration and stop immediately',
      default: false,
    },
  },
  async run({ args }) {
    // Stop listener if running (needs workspace context)
    let workspaceRoot: string | undefined;
    try {
      const workspace = await discoverWorkspace(process.cwd());
      workspaceRoot = workspace.root;
    } catch {
      // Not in a workspace, no listener to stop
    }

    if (workspaceRoot) {
      const listenerStatus = await getListenerDaemonStatus(workspaceRoot);
      if (listenerStatus?.running) {
        await stopListener(workspaceRoot);
        log.success('Listener stopped');
      }
    }

    // Stop Verdaccio
    const status = await getDaemonStatus();
    if (!status?.running) {
      log.warn('Verdaccio is not running');
      return;
    }

    // With --force, stop immediately (old behavior)
    if (args.force) {
      await stopDaemon();
      log.success('Verdaccio stopped');
      return;
    }

    // Restore all consumer repos before stopping
    const allRepos = await loadAllRepos();
    const reposWithPackages = allRepos.filter(
      r => Object.keys(r.state.packages).length > 0,
    );

    if (reposWithPackages.length === 0) {
      await stopDaemon();
      log.success('Verdaccio stopped');
      return;
    }

    log.info(`Restoring ${reposWithPackages.length} consumer repo${reposWithPackages.length > 1 ? 's' : ''}...`);

    const failedRepos: Array<{ name: string; error: string }> = [];

    for (const repo of reposWithPackages) {
      const repoPath = repo.state.path;
      const pkgNames = Object.keys(repo.state.packages);

      try {
        // Restore each package
        for (const name of pkgNames) {
          const link = repo.state.packages[name];
          await restorePackage(repoPath, name, link.targets, link.catalogName, link.catalogFormat);
          delete repo.state.packages[name];
        }
        await saveRepoByPath(repo.state.path, repo.state);

        // Clean up .npmrc and hooks since all packages are restored
        await removeRegistryFromNpmrc(repoPath);
        await removeSkipWorktree(repoPath);
        await removePreCommitHook(repoPath);

        // Run pm install to sync node_modules
        await runInstall(repoPath);

        log.success(`Restored ${repo.displayName} ${c.dim(`(${pkgNames.length} package${pkgNames.length > 1 ? 's' : ''})`)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedRepos.push({ name: repo.displayName, error: message });
        log.error(`Failed to restore ${repo.displayName}: ${message}`);
      }
    }

    if (failedRepos.length > 0) {
      log.line('');
      log.error(
        `${failedRepos.length} repo${failedRepos.length > 1 ? 's' : ''} failed to restore. ` +
        'Fix the issues and retry, or run `pkglab down --force` to stop without restoring.',
      );
      process.exit(1);
    }

    await stopDaemon();
    log.success('Verdaccio stopped');
  },
});
