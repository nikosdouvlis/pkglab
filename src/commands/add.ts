import { defineCommand } from "citty";
import { ensureDaemonRunning } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import {
  addRegistryToNpmrc,
  applySkipWorktree,
  ensureNpmrcForActiveRepos,
  updatePackageJsonVersion,
  removePackageJsonDependency,
  findCatalogRoot,
  findCatalogEntry,
  updateCatalogVersion,
} from "../lib/consumer";
import {
  canonicalRepoPath,
  repoFileName,
  loadRepoState,
  saveRepoState,
} from "../lib/repo-state";
import {
  getDistTags,
  listPackageNames,
} from "../lib/registry";
import { sanitizeTag, ispkglabVersion, extractTag } from "../lib/version";
import { join } from "node:path";
import { detectPackageManager, batchInstallCommand } from "../lib/pm-detect";
import { run } from "../lib/proc";
import { log } from "../lib/log";
import { c } from "../lib/color";
import type { pkglabConfig, RepoState } from "../types";

function parsePackageArg(input: string): { name: string; tag?: string } {
  const lastAt = input.lastIndexOf("@");
  // If lastAt is 0, it's just @scope/pkg with no tag
  // If lastAt > 0, there might be a tag after it
  if (lastAt > 0) {
    const name = input.slice(0, lastAt);
    const tag = input.slice(lastAt + 1);
    if (tag) return { name, tag };
  }
  return { name: input };
}

interface ResolvedPackage {
  name: string;
  version: string;
  tag: string | undefined;
}

function resolveFromDistTags(
  pkgName: string,
  distTags: Record<string, string>,
  requestedTag?: string,
): ResolvedPackage {
  const tag = requestedTag ? sanitizeTag(requestedTag) : undefined;
  const distTagKey = tag ?? "pkglab";
  const version = distTags[distTagKey];

  if (!version) {
    const available = Object.keys(distTags).filter((t) => t !== "latest");
    if (available.length === 0) {
      log.error(
        `No pkglab versions for ${pkgName}. Publish first: pkglab pub ${pkgName}`,
      );
    } else if (tag) {
      const tagList = available.filter((t) => t !== "pkglab").join(", ");
      const hasUntagged = "pkglab" in distTags;
      const untaggedNote = hasUntagged ? " Also has untagged versions." : "";
      log.error(
        `No version for '${pkgName}' with tag '${tag}'. Available: ${tagList || "(none)"}.${untaggedNote}`,
      );
    } else {
      const tagList = available.filter((t) => t !== "pkglab").join(", ");
      log.error(
        `No untagged version for '${pkgName}'. Available tags: ${tagList}`,
      );
    }
    process.exit(1);
  }

  return { name: pkgName, version, tag };
}

async function batchInstallPackages(
  config: pkglabConfig,
  repoPath: string,
  packages: ResolvedPackage[],
  catalog?: boolean,
): Promise<void> {
  // Catalog mode: find workspace root, update catalog entries, run bun install
  if (catalog) {
    const catalogRoot = await findCatalogRoot(repoPath);
    if (!catalogRoot) {
      log.error("No catalog found. The workspace root package.json needs a 'catalog' or 'catalogs' field.");
      process.exit(1);
    }

    const rootPkgJson = await Bun.file(join(catalogRoot, "package.json")).json();

    // Validate all packages exist in the catalog before making changes
    const entries: { name: string; version: string; catalogName: string }[] = [];
    for (const pkg of packages) {
      const entry = findCatalogEntry(rootPkgJson, pkg.name);
      if (!entry) {
        log.error(`${pkg.name} is not in any catalog. Add it to the catalog field in the workspace root package.json first.`);
        process.exit(1);
      }
      entries.push({ name: pkg.name, version: pkg.version, catalogName: entry.catalogName });
    }

    const { isFirstTime } = await addRegistryToNpmrc(catalogRoot, config.port);
    if (isFirstTime) {
      await applySkipWorktree(catalogRoot);
      log.info(
        "notice: pkglab added registry entries to .npmrc\n" +
          "These entries point to localhost and will break CI if committed.\n" +
          "pkglab has applied --skip-worktree to prevent accidental commits.\n" +
          "Run pkglab restore --all to restore your .npmrc.",
      );
    }

    // Update catalog entries, storing previous versions for rollback
    const prevVersions: { name: string; version: string | null; catalogName: string }[] = [];
    for (const entry of entries) {
      const { previousVersion } = await updateCatalogVersion(catalogRoot, entry.name, entry.version, entry.catalogName);
      prevVersions.push({ name: entry.name, version: previousVersion, catalogName: entry.catalogName });
    }

    // Run bun install at the workspace root (catalog changes are picked up automatically)
    const pm = await detectPackageManager(catalogRoot);
    const cmd = [pm, "install"];
    log.dim(`  ${cmd.join(" ")}`);
    const result = await run(cmd, { cwd: catalogRoot });
    if (result.exitCode !== 0) {
      for (const prev of prevVersions) {
        if (prev.version !== null) {
          await updateCatalogVersion(catalogRoot, prev.name, prev.version, prev.catalogName);
        }
      }
      const output = (result.stderr || result.stdout).trim();
      throw new Error(`Install failed (${pm}): ${output}`);
    }

    // Update repo state (use catalogRoot as the repo path)
    const repoFile = await repoFileName(catalogRoot);
    let repoState: RepoState = (await loadRepoState(repoFile)) || {
      path: catalogRoot,
      active: false,
      packages: {},
    };

    for (let i = 0; i < packages.length; i++) {
      const { name, version, tag } = packages[i];
      const catalogName = entries[i].catalogName;
      if (!repoState.packages[name]) {
        repoState.packages[name] = {
          original: prevVersions[i].version ?? "",
          current: version,
          tag,
          catalogName,
        };
      } else {
        repoState.packages[name].current = version;
        repoState.packages[name].tag = tag;
        repoState.packages[name].catalogName = catalogName;
      }
    }

    repoState.active = true;
    repoState.lastUsed = Date.now();
    await saveRepoState(repoFile, repoState);
    for (const { name, version } of packages) {
      log.success(`Installed ${name}@${version} (catalog)`);
    }
    return;
  }

  // Standard mode: update individual package.json deps
  const { isFirstTime } = await addRegistryToNpmrc(repoPath, config.port);
  if (isFirstTime) {
    await applySkipWorktree(repoPath);
    log.info(
      "notice: pkglab added registry entries to .npmrc\n" +
        "These entries point to localhost and will break CI if committed.\n" +
        "pkglab has applied --skip-worktree to prevent accidental commits.\n" +
        "Run pkglab restore --all to restore your .npmrc.",
    );
  }

  // Detect stale pkglab deps in consumer's package.json that aren't in the current batch
  const batchNames = new Set(packages.map((p) => p.name));
  const pkgJson = await Bun.file(join(repoPath, "package.json")).json();
  const staleDeps: { name: string; version: string }[] = [];

  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkgJson[field];
    if (!deps) continue;
    for (const [depName, depVersion] of Object.entries(deps)) {
      if (
        typeof depVersion === "string" &&
        ispkglabVersion(depVersion) &&
        !batchNames.has(depName)
      ) {
        staleDeps.push({ name: depName, version: depVersion });
      }
    }
  }

  if (staleDeps.length > 0) {
    const unresolvable: string[] = [];

    for (const dep of staleDeps) {
      const distTags = await getDistTags(dep.name);
      const tag = extractTag(dep.version);
      const distTagKey = tag ?? "pkglab";
      const latestVersion = distTags[distTagKey];

      if (latestVersion) {
        packages.push({ name: dep.name, version: latestVersion, tag: tag ?? undefined });
        log.dim(`  Upgrading stale ${dep.name}@${dep.version} to ${latestVersion}`);
      } else {
        unresolvable.push(dep.name);
      }
    }

    if (unresolvable.length > 0) {
      log.error(
        `These pkglab packages have stale versions in package.json but no matching version on the registry:\n` +
          unresolvable.map((n) => `  ${n}`).join("\n") +
          `\nRun pkglab restore for these packages first: pkglab restore ${unresolvable.join(" ")}`,
      );
      process.exit(1);
    }
  }

  // Update all package.json versions before installing
  const prevVersions: { name: string; version: string | null }[] = [];
  for (const { name, version } of packages) {
    const { previousVersion } = await updatePackageJsonVersion(repoPath, name, version);
    prevVersions.push({ name, version: previousVersion });
  }

  // One batch install for all packages
  const pm = await detectPackageManager(repoPath);
  const cmd = batchInstallCommand(pm, packages.map((p) => ({ name: p.name, version: p.version })));
  log.dim(`  ${cmd.join(" ")}`);
  const result = await run(cmd, { cwd: repoPath });
  if (result.exitCode !== 0) {
    // Revert package.json so it stays consistent with node_modules
    for (const prev of prevVersions) {
      if (prev.version !== null) {
        await updatePackageJsonVersion(repoPath, prev.name, prev.version);
      } else {
        await removePackageJsonDependency(repoPath, prev.name);
      }
    }
    const output = (result.stderr || result.stdout).trim();
    throw new Error(`Install failed (${pm}): ${output}`);
  }

  // Update repo state
  const repoFile = await repoFileName(repoPath);
  let repoState: RepoState = (await loadRepoState(repoFile)) || {
    path: repoPath,
    active: false,
    packages: {},
  };

  for (const { name, version, tag } of packages) {
    if (!repoState.packages[name]) {
      const prev = prevVersions.find((p) => p.name === name);
      repoState.packages[name] = {
        original: prev?.version ?? "",
        current: version,
        tag,
      };
    } else {
      repoState.packages[name].current = version;
      repoState.packages[name].tag = tag;
    }
  }

  repoState.active = true;
  repoState.lastUsed = Date.now();
  await saveRepoState(repoFile, repoState);
  for (const { name, version } of packages) {
    log.success(`Installed ${name}@${version}`);
  }
}

async function interactivePick(): Promise<ResolvedPackage[]> {
  const [packageNames, { filterableCheckbox }, { select }, { ExitPromptError }] =
    await Promise.all([
      listPackageNames(),
      import("../lib/prompt"),
      import("@inquirer/prompts"),
      import("@inquirer/core"),
    ]);

  if (packageNames.length === 0) {
    log.error("No pkglab packages found. Publish first: pkglab pub");
    process.exit(1);
  }

  let selectedNames: string[];
  try {
    selectedNames = await filterableCheckbox({
      message: "Select packages to add:",
      pageSize: 15,
      choices: packageNames.map((name) => ({ name, value: name })),
    });
  } catch (err) {
    if (err instanceof ExitPromptError) process.exit(0);
    throw err;
  }

  if (selectedNames.length === 0) {
    log.dim("No packages selected.");
    return [];
  }

  const resolved: ResolvedPackage[] = [];
  for (const pkgName of selectedNames) {
    const distTags = await getDistTags(pkgName);
    const tags = Object.keys(distTags).filter((t) => t !== "latest");
    let selectedTag: string | undefined;

    if (tags.length === 0) {
      log.error(`No pkglab versions for ${pkgName}. Publish first.`);
      continue;
    } else if (tags.length === 1) {
      selectedTag = tags[0] === "pkglab" ? undefined : tags[0];
    } else {
      try {
        const picked = await select<string>({
          message: `Tag for ${pkgName}:`,
          choices: tags.map((t) => ({
            name: t === "pkglab" ? c.dim("(untagged)") : t,
            value: t,
          })),
        });
        selectedTag = picked === "pkglab" ? undefined : picked;
      } catch (err) {
        if (err instanceof ExitPromptError) process.exit(0);
        throw err;
      }
    }

    resolved.push(resolveFromDistTags(pkgName, distTags, selectedTag));
  }

  return resolved;
}

export default defineCommand({
  meta: { name: "add", description: "Add a pkglab package to this repo" },
  args: {
    name: {
      type: "positional",
      description: "Package name(s) or name@tag",
      required: false,
    },
    catalog: {
      type: "boolean",
      description: "Update the workspace catalog instead of individual package.json",
      default: false,
    },
  },
  async run({ args }) {
    const config = await loadConfig();
    const names = ((args as any)._ as string[] | undefined) ?? [];
    const catalog = args.catalog as boolean;

    const [, repoPath] = await Promise.all([
      ensureDaemonRunning(),
      canonicalRepoPath(process.cwd()),
    ]);

    let resolved: ResolvedPackage[];
    if (names.length === 0) {
      resolved = await interactivePick();
    } else {
      const parsed = names.map(parsePackageArg);
      const distTagResults = await Promise.all(parsed.map((p) => getDistTags(p.name)));
      resolved = parsed.map((p, i) => resolveFromDistTags(p.name, distTagResults[i], p.tag));
    }

    if (resolved.length > 0) {
      await batchInstallPackages(config, repoPath, resolved, catalog);
      await ensureNpmrcForActiveRepos(config.port);
    }
  },
});
