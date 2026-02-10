import { join } from "node:path";
import { tmpdir } from "node:os";
import { cp, rm, mkdir } from "node:fs/promises";
import type {
  PublishPlan,
  PublishEntry,
  WorkspacePackage,
  pkglabConfig,
} from "../types";
import { log } from "./log";
import { run, npmEnvWithAuth } from "./proc";

export function buildPublishPlan(
  packages: WorkspacePackage[],
  version: string,
  catalogs: Record<string, Record<string, string>> = {},
): PublishPlan {
  const publishNames = new Set(packages.map((p) => p.name));

  const entries: PublishEntry[] = packages.map((pkg) => {
    const rewrittenDeps: Record<string, string> = {};

    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const deps = pkg.packageJson[field];
      if (!deps) continue;
      for (const depName of Object.keys(deps)) {
        if (publishNames.has(depName)) {
          rewrittenDeps[depName] = version;
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
}

export async function executePublish(
  plan: PublishPlan,
  config: pkglabConfig,
  options: PublishOptions = {},
): Promise<void> {
  const registryUrl = `http://127.0.0.1:${config.port}`;

  const results = await Promise.allSettled(
    plan.packages.map(async (entry, index) => {
      if (options.verbose) {
        log.info(`Publishing ${entry.name}@${entry.version}`);
      }
      try {
        await publishSinglePackage(entry, registryUrl, plan.catalogs);
        options.onPublished?.(index);
        return `${entry.name}@${entry.version}`;
      } catch (error) {
        options.onFailed?.(index);
        throw error;
      }
    }),
  );

  const published: string[] = [];
  const failed: string[] = [];
  let firstError: Error | undefined;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const spec = `${plan.packages[i].name}@${plan.packages[i].version}`;
    if (result.status === "fulfilled") {
      published.push(spec);
    } else {
      failed.push(spec);
      if (!firstError) firstError = result.reason;
    }
  }

  if (failed.length > 0) {
    log.error(`Failed to publish: ${failed.join(", ")}`);

    // Rollback the ones that succeeded
    if (published.length > 0) {
      log.error("Rolling back successful publishes...");
      const rollbackFailures: string[] = [];
      await Promise.all(
        published.map(async (spec) => {
          const ok = await rollbackPackage(spec, registryUrl);
          if (!ok) rollbackFailures.push(spec);
        }),
      );
      if (rollbackFailures.length > 0) {
        log.error(
          `Rollback incomplete — these packages may still exist in registry: ${rollbackFailures.join(", ")}`,
        );
      }
    }

    throw firstError;
  }
}

async function publishSinglePackage(
  entry: PublishEntry,
  registryUrl: string,
  catalogs: Record<string, Record<string, string>>,
): Promise<void> {
  const safeName = entry.name.replace("/", "-").replace("@", "");
  const tempDir = join(tmpdir(), `pkglab-${safeName}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    await cp(entry.dir, tempDir, {
      recursive: true,
      filter: (src) => {
        const base = src.slice(entry.dir.length + 1);
        if (base === "node_modules" || base === ".git" || base === ".turbo") return false;
        if (base.startsWith("node_modules/") || base.startsWith(".git/") || base.startsWith(".turbo/")) return false;
        return true;
      },
    });

    const pkgJsonPath = join(tempDir, "package.json");
    const pkgJson = await Bun.file(pkgJsonPath).json();

    pkgJson.version = entry.version;

    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "devDependencies",
    ]) {
      if (!pkgJson[field]) continue;
      for (const [name, version] of Object.entries(pkgJson[field])) {
        if (entry.rewrittenDeps[name]) {
          pkgJson[field][name] = entry.rewrittenDeps[name];
        } else if (
          typeof version === "string" &&
          version.startsWith("workspace:")
        ) {
          pkgJson[field][name] = resolveWorkspaceProtocol(version as string);
        } else if (
          typeof version === "string" &&
          version.startsWith("catalog:")
        ) {
          pkgJson[field][name] = resolveCatalogProtocol(
            version as string,
            name,
            catalogs,
          );
        }
      }
    }

    await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

    // Write .npmrc with registry + dummy auth so npm doesn't require login
    const registryHost = registryUrl.replace(/^https?:/, "");
    const npmrc = `registry=${registryUrl}\n${registryHost}/:_authToken=pkglab-local\n`;
    await Bun.write(join(tempDir, ".npmrc"), npmrc);

    const result = await run(
      ["npm", "publish", "--registry", registryUrl, "--no-git-checks", "--access", "public"],
      { cwd: tempDir },
    );
    if (result.exitCode !== 0) {
      throw new Error(`npm publish failed for ${entry.name}: ${result.stderr}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function rollbackPackage(
  spec: string,
  registryUrl: string,
): Promise<boolean> {
  try {
    const result = await run(
      ["npm", "unpublish", spec, "--registry", registryUrl, "--force"],
      { env: npmEnvWithAuth(registryUrl) },
    );
    if (result.exitCode !== 0) {
      log.warn(`Failed to rollback ${spec}`);
      return false;
    }
    return true;
  } catch {
    log.warn(`Failed to rollback ${spec}`);
    return false;
  }
}

function resolveCatalogProtocol(
  spec: string,
  pkgName: string,
  catalogs: Record<string, Record<string, string>>,
): string {
  const catalogName = spec.slice("catalog:".length);
  const catalog = catalogs[catalogName];
  if (catalog?.[pkgName]) return catalog[pkgName];
  // Default catalog (catalog:) with no name
  if (!catalogName && catalogs["default"]?.[pkgName])
    return catalogs["default"][pkgName];
  log.warn(`Could not resolve ${spec} for ${pkgName}, using *`);
  return "*";
}

function resolveWorkspaceProtocol(spec: string): string {
  const value = spec.slice("workspace:".length);
  // Shorthand forms (workspace:^, workspace:~, workspace:*) are only valid between
  // workspace siblings. Those siblings should be in rewrittenDeps and never reach here.
  // If they do (edge case), strip to a permissive range that Verdaccio can proxy-resolve.
  if (value === "*") return "*";
  if (value === "^" || value === "~") return "*";
  // Full form: workspace:^1.0.0 -> ^1.0.0, workspace:~2.3.0 -> ~2.3.0
  return value;
}
