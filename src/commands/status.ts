import { defineCommand } from 'citty';

import { loadConfig } from '../lib/config';
import { getDaemonStatus } from '../lib/daemon';
import { getListenerDaemonStatus } from '../lib/listener-daemon';
import { log } from '../lib/log';
import { discoverWorkspace } from '../lib/workspace';

export default defineCommand({
  meta: { name: 'status', description: 'Show pkglab status' },
  async run() {
    const config = await loadConfig();
    const status = await getDaemonStatus();

    if (status?.running) {
      log.success(`Verdaccio running on http://127.0.0.1:${config.port} (PID ${status.pid})`);
    } else {
      log.info('Verdaccio is not running');
    }

    // Show listener status if in a workspace
    try {
      const workspace = await discoverWorkspace(process.cwd());
      const listenerStatus = await getListenerDaemonStatus(workspace.root);
      if (listenerStatus?.running) {
        log.success(`Listener running (PID ${listenerStatus.pid})`);
      } else {
        log.info('Listener is not running');
      }
    } catch {
      // Not in a workspace, skip listener status
    }
  },
});
