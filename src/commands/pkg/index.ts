import { defineCommand } from 'citty';

export default defineCommand({
  meta: { name: 'pkg', description: 'Manage packages in the registry' },
  subCommands: {
    ls: () => import('./ls').then(m => m.default),
    rm: () => import('./rm').then(m => m.default),
  },
});
