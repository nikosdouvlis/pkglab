import { defineCommand } from 'citty';

export default defineCommand({
  meta: { name: 'hooks', description: 'Manage repo lifecycle hooks' },
  subCommands: {
    init: () => import('./init').then(m => m.default),
  },
});
