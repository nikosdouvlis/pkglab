import { join } from "node:path";
import { tmpdir } from "node:os";
import { cp, rm, mkdir } from "node:fs/promises";
import type { PublishPlan, PublishEntry, WorkspacePackage, PkglConfig } from "../types";
import { log } from "./log";

export function buildPublishPlan(
  packages: WorkspacePackage[],
  version: string
): PublishPlan {
  const publishNames = new Set(packages.map((p) => p.name));

  const entries: PublishEntry[] = packages.map((pkg) => {
    const rewrittenDeps: Record<string, string> = {};

    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
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

  return { timestamp: Date.now(), packages: entries };
}

export async function executePublish(
  plan: PublishPlan,
  config: PkglConfig
): Promise<void> {
  const registryUrl = `http://127.0.0.1:${config.port}`;
  const published: string[] = [];

  try {
    for (const entry of plan.packages) {
      log.info(`Publishing ${entry.name}@${entry.version}`);
      await publishSinglePackage(entry, registryUrl);
      published.push(`${entry.name}@${entry.version}`);
    }
  } catch (err) {
    log.error("Publish failed, rolling back...");
    const rollbackFailures: string[] = [];
    for (const spec of published) {
      const ok = await rollbackPackage(spec, registryUrl);
      if (!ok) rollbackFailures.push(spec);
    }
    if (rollbackFailures.length > 0) {
      log.error(`Rollback incomplete — these packages may still exist in registry: ${rollbackFailures.join(", ")}`);
    }
    throw err;
  }
}

async function publishSinglePackage(
  entry: PublishEntry,
  registryUrl: string
): Promise<void> {
  const safeName = entry.name.replace("/", "-").replace("@", "");
  const tempDir = join(tmpdir(), `pkgl-${safeName}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    await cp(entry.dir, tempDir, { recursive: true });

    const pkgJsonPath = join(tempDir, "package.json");
    const pkgJson = await Bun.file(pkgJsonPath).json();

    pkgJson.version = entry.version;

    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      if (!pkgJson[field]) continue;
      for (const [name, version] of Object.entries(pkgJson[field])) {
        if (entry.rewrittenDeps[name]) {
          pkgJson[field][name] = entry.rewrittenDeps[name];
        } else if (typeof version === "string" && version.startsWith("workspace:")) {
          pkgJson[field][name] = (version as string).replace("workspace:", "");
        }
      }
    }

    // Strip workspace protocol from devDependencies too (they go into published manifest)
    if (pkgJson.devDependencies) {
      for (const [name, version] of Object.entries(pkgJson.devDependencies)) {
        if (typeof version === "string" && version.startsWith("workspace:")) {
          pkgJson.devDependencies[name] = (version as string).replace("workspace:", "");
        }
      }
    }

    await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

    // Remove node_modules from temp dir if copied
    await rm(join(tempDir, "node_modules"), { recursive: true, force: true });

    const proc = Bun.spawn(
      ["npm", "publish", "--registry", registryUrl, "--no-git-checks", "--access", "public"],
      { cwd: tempDir, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`npm publish failed for ${entry.name}: ${stderr}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function rollbackPackage(spec: string, registryUrl: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["npm", "unpublish", spec, "--registry", registryUrl, "--force"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log.warn(`Failed to rollback ${spec}`);
      return false;
    }
    return true;
  } catch {
    log.warn(`Failed to rollback ${spec}`);
    return false;
  }
}
