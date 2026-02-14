import { defineCommand } from 'citty';

import { stopDaemon, getDaemonStatus } from '../lib/daemon';
import { stopListener, getListenerDaemonStatus } from '../lib/listener-daemon';
import { log } from '../lib/log';
import { discoverWorkspace } from '../lib/workspace';

export default defineCommand({
  meta: { name: 'down', description: 'Stop pkglab services' },
  async run() {
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
    await stopDaemon();
    log.success('Verdaccio stopped');
  },
});
