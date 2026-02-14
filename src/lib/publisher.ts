import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { PublishPlan, PublishEntry, WorkspacePackage, pkglabConfig } from '../types';

import { log } from './log';
import { run } from './proc';
import { registryUrl } from './registry';
import { extractTag } from './version';

export function buildPublishPlan(
  packages: WorkspacePackage[],
  version: string,
  catalogs: Record<string, Record<string, string>> = {},
  existingVersions: Map<string, string> = new Map(),
): PublishPlan {
  const publishNames = new Set(packages.map(p => p.name));

  const entries: PublishEntry[] = packages.map(pkg => {
    const rewrittenDeps: Record<string, string> = {};

    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg.packageJson[field];
      if (!deps) {
        continue;
      }
      for (const depName of Object.keys(deps)) {
        if (publishNames.has(depName)) {
          rewrittenDeps[depName] = version;
        } else if (existingVersions.has(depName)) {
          rewrittenDeps[depName] = existingVersions.get(depName)!;
        }
      }
    }

    return { name: pkg.name, dir: pkg.dir, version, rewrittenDeps };
  });

  return { timestamp: Date.now(), packages: entries, catalogs };
}

export interface PublishOptions {
  verbose?: boolean;
  onPublished?: (index: number) => void;
  onFailed?: (index: number) => void;
  onPackagePublished?: (entry: PublishEntry) => void;
}

export async function executePublish(
  plan: PublishPlan,
  config: pkglabConfig,
  options: PublishOptions = {},
  workspaceRoot?: string,
): Promise<void> {
  const url = registryUrl(config);

  // Write .npmrc at the workspace root so bun/npm can find auth.
  // Package-level .npmrc is ignored inside workspaces on some platforms.
  const npmrcCleanup = workspaceRoot ? await writeWorkspaceNpmrc(workspaceRoot, url) : undefined;

  try {
    const results = await Promise.allSettled(
      plan.packages.map(async (entry, index) => {
        if (options.verbose) {
          log.info(`Publishing ${entry.name}@${entry.version}`);
        }
        try {
          await publishSinglePackage(entry, url, plan.catalogs);
          options.onPublished?.(index);
          options.onPackagePublished?.(entry);
          return `${entry.name}@${entry.version}`;
        } catch (error) {
          options.onFailed?.(index);
          throw error;
        }
      }),
    );

    const failed: string[] = [];
    let firstError: Error | undefined;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const spec = `${plan.packages[i].name}@${plan.packages[i].version}`;
        failed.push(spec);
        if (!firstError) {
          firstError = result.reason;
        }
      }
    }

    if (failed.length > 0) {
      log.error(`Failed to publish: ${failed.join(', ')}`);
      throw firstError;
    }
  } finally {
    await npmrcCleanup?.();
  }
}

export const BACKUP_SUFFIX = '.pkglab';

async function publishSinglePackage(
  entry: PublishEntry,
  registryUrl: string,
  catalogs: Record<string, Record<string, string>>,
): Promise<void> {
  const pkgJsonPath = join(entry.dir, 'package.json');
  const backupPath = join(entry.dir, `package.json${BACKUP_SUFFIX}`);

  // Recover any leftover backups from a previous crashed publish
  await recoverBackup(backupPath, pkgJsonPath);

  // Read and modify package.json in memory
  const pkgJson = await Bun.file(pkgJsonPath).json();
  pkgJson.version = entry.version;

  const runtimeFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];

  for (const field of [...runtimeFields, 'devDependencies']) {
    if (!pkgJson[field]) {
      continue;
    }
    const isRuntime = runtimeFields.includes(field);
    for (const [name, version] of Object.entries(pkgJson[field])) {
      if (entry.rewrittenDeps[name]) {
        pkgJson[field][name] = entry.rewrittenDeps[name];
      } else if (typeof version === 'string' && version.startsWith('workspace:')) {
        const inner = version.slice('workspace:'.length);
        if (isRuntime && (inner === '^' || inner === '~' || inner === '*')) {
          throw new Error(
            `${entry.name} has workspace dep "${name}" (${version}) that is not in the publish set. ` +
              `This is a bug in cascade computation.`,
          );
        }
        pkgJson[field][name] = resolveWorkspaceProtocol(version);
      } else if (typeof version === 'string' && version.startsWith('catalog:')) {
        pkgJson[field][name] = resolveCatalogProtocol(version, name, catalogs);
      }
    }
  }

  // Rename original to .pkglab backup
  await rename(pkgJsonPath, backupPath);

  try {
    // Write modified package.json
    await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');

    const tag = extractTag(entry.version);
    const distTag = tag ? `pkglab-${tag}` : 'pkglab';

    const cmd = ['bun', 'publish', '--registry', registryUrl, '--tag', distTag, '--access', 'public'];
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await run(cmd, { cwd: entry.dir });
      if (result.exitCode === 0) {
        break;
      }

      if (attempt < maxAttempts) {
        log.warn(`Publish attempt ${attempt}/${maxAttempts} failed for ${entry.name}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        continue;
      }

      throw new Error(`bun publish failed for ${entry.name}: ${result.stderr}`);
    }
  } finally {
    // Restore original package.json
    await rm(pkgJsonPath, { force: true }).catch(() => {});
    await rename(backupPath, pkgJsonPath).catch(() => {});
  }
}

// Write .npmrc at the workspace root with registry auth.
// Must be at the root because Bun ignores package-level .npmrc when
// XDG_CONFIG_HOME is set (common on Linux/CI). See https://github.com/oven-sh/bun/issues/23128
// Returns a cleanup function that restores the original state.
async function writeWorkspaceNpmrc(workspaceRoot: string, url: string): Promise<() => Promise<void>> {
  const npmrcPath = join(workspaceRoot, '.npmrc');
  const backupPath = join(workspaceRoot, `.npmrc${BACKUP_SUFFIX}`);
  const registryHost = url.replace(/^https?:/, '');
  const npmrc = `registry=${url}\n${registryHost}/:_authToken=pkglab-local\n`;

  // Backup existing .npmrc if present
  const hadNpmrc = await Bun.file(npmrcPath).exists();
  if (hadNpmrc) {
    await rename(npmrcPath, backupPath);
  }

  await Bun.write(npmrcPath, npmrc);

  return async () => {
    await rm(npmrcPath, { force: true }).catch(() => {});
    if (hadNpmrc) {
      await rename(backupPath, npmrcPath).catch(() => {});
    }
  };
}

async function recoverBackup(backupPath: string, targetPath: string): Promise<void> {
  if (await Bun.file(backupPath).exists()) {
    log.warn(`Recovering leftover backup: ${backupPath}`);
    await rm(targetPath, { force: true });
    await rename(backupPath, targetPath);
  }
}

function resolveCatalogProtocol(
  spec: string,
  pkgName: string,
  catalogs: Record<string, Record<string, string>>,
): string {
  const catalogName = spec.slice('catalog:'.length);
  const catalog = catalogs[catalogName];
  if (catalog?.[pkgName]) {
    return catalog[pkgName];
  }
  // Default catalog (catalog:) with no name
  if (!catalogName && catalogs['default']?.[pkgName]) {
    return catalogs['default'][pkgName];
  }
  log.warn(`Could not resolve ${spec} for ${pkgName}, using *`);
  return '*';
}

function resolveWorkspaceProtocol(spec: string): string {
  const value = spec.slice('workspace:'.length);
  // Shorthand forms (workspace:^, workspace:~, workspace:*) are only valid between
  // workspace siblings. Those siblings should be in rewrittenDeps and never reach here.
  // If they do (edge case), strip to a permissive range that Verdaccio can proxy-resolve.
  if (value === '*') {
    return '*';
  }
  if (value === '^' || value === '~') {
    return '*';
  }
  // Full form: workspace:^1.0.0 -> ^1.0.0, workspace:~2.3.0 -> ~2.3.0
  return value;
}
