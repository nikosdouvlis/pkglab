import { defineCommand } from 'citty';

import { getListenerLogPath } from '../lib/listener-ipc';
import { log } from '../lib/log';
import { paths } from '../lib/paths';
import { discoverWorkspace } from '../lib/workspace';

export default defineCommand({
  meta: { name: 'logs', description: 'Tail pkglab logs' },
  args: {
    follow: { type: 'boolean', alias: 'f', description: 'Stream logs', default: false },
    listener: { type: 'boolean', description: 'Show only listener logs', default: false },
    registry: { type: 'boolean', description: 'Show only registry logs', default: false },
  },
  async run({ args }) {
    const files: string[] = [];

    // Registry logs (unless --listener only)
    if (!args.listener) {
      const registryLog = Bun.file(paths.logFile);
      if (await registryLog.exists()) {
        files.push(paths.logFile);
      }
    }

    // Listener logs (unless --registry only)
    if (!args.registry) {
      try {
        const workspace = await discoverWorkspace(process.cwd());
        const listenerLogPath = getListenerLogPath(workspace.root);
        const listenerLog = Bun.file(listenerLogPath);
        if (await listenerLog.exists()) {
          files.push(listenerLogPath);
        }
      } catch {
        // Not in a workspace, skip listener logs
      }
    }

    if (files.length === 0) {
      log.warn('No log files found');
      return;
    }

    const cmd = args.follow ? ['tail', '-f', ...files] : ['tail', '-50', ...files];

    const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
    await proc.exited;
  },
});
