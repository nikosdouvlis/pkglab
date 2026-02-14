import { defineCommand } from 'citty';

import { getPositionalArgs, normalizeScope } from '../lib/args';
import { removeRegistryFromNpmrc, removeSkipWorktree, restorePackage } from '../lib/consumer';
import { log } from '../lib/log';
import { runInstall } from '../lib/pm-detect';
import { canonicalRepoPath, findRepoByPath, saveRepoByPath } from '../lib/repo-state';
import { extractTag } from '../lib/version';

export default defineCommand({
  meta: {
    name: 'restore',
    description: 'Restore pkglab packages to their original versions',
  },
  args: {
    name: { type: 'positional', description: 'Package name(s)', required: false },
    all: { type: 'boolean', description: 'Restore all pkglab packages', default: false },
    scope: {
      type: 'string',
      description: 'Restore all packages matching a scope (e.g. clerk or @clerk)',
    },
    tag: {
      type: 'string',
      alias: 't',
      description: 'Only restore packages installed with this tag',
    },
  },
  async run({ args }) {
    const names = getPositionalArgs(args);
    const scope = args.scope as string | undefined;
    const tag = args.tag as string | undefined;

    // Validation
    if (scope && names.length > 0) {
      log.error('Cannot combine --scope with package names. Use one or the other.');
      process.exit(1);
    }

    const repoPath = await canonicalRepoPath(process.cwd());
    const repo = await findRepoByPath(repoPath);

    if (!repo || Object.keys(repo.state.packages).length === 0) {
      log.warn('No pkglab packages in this repo');
      return;
    }

    // Determine which packages to restore
    let toRestore: string[];

    if (scope) {
      const prefix = normalizeScope(scope);
      if (!prefix) {
        log.error(`Invalid scope: "${scope}". Use a scope name like "clerk" or "@clerk".`);
        process.exit(1);
      }
      toRestore = Object.keys(repo.state.packages).filter(name => name.startsWith(prefix));
      if (toRestore.length === 0) {
        log.warn(`No pkglab packages matching scope '${prefix.slice(0, -1)}' in this repo`);
        return;
      }
    } else if (args.all) {
      toRestore = Object.keys(repo.state.packages);
    } else if (names.length > 0) {
      toRestore = names;
    } else {
      log.error('Specify package name(s), --scope, or --all');
      process.exit(1);
    }

    // Filter by tag if provided
    if (tag) {
      toRestore = toRestore.filter(name => {
        const link = repo.state.packages[name];
        if (!link) {
          return false;
        }
        // Check stored tag on the link
        if (link.tag === tag) {
          return true;
        }
        // Also check if the current version has the matching tag
        const versionTag = extractTag(link.current);
        return versionTag === tag;
      });
      if (toRestore.length === 0) {
        log.warn(`No pkglab packages with tag '${tag}' in this repo`);
        return;
      }
    }

    // Validate all names exist in repo state
    const missing = toRestore.filter(name => !repo.state.packages[name]);
    if (missing.length > 0) {
      for (const name of missing) {
        log.warn(`${name} is not linked via pkglab in this repo`);
      }
      toRestore = toRestore.filter(name => repo.state.packages[name]);
      if (toRestore.length === 0) {
        return;
      }
    }

    // Restore each package
    for (const name of toRestore) {
      const link = repo.state.packages[name];
      await restorePackage(repoPath, name, link.targets, link.catalogName, link.catalogFormat);
      delete repo.state.packages[name];
    }
    await saveRepoByPath(repo.state.path, repo.state);

    // Clean up .npmrc if no packages remain
    if (Object.keys(repo.state.packages).length === 0) {
      await removeRegistryFromNpmrc(repoPath);
      await removeSkipWorktree(repoPath);
      log.info('All pkglab packages removed, .npmrc restored');
    }

    // Run pm install once
    await runInstall(repoPath);

    if (toRestore.length === 1) {
      log.success(`Restored ${toRestore[0]}`);
    } else {
      log.success(`Restored ${toRestore.length} packages`);
    }
  },
});
