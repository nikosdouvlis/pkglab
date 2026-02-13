import { defineCommand } from "citty";
import { ensureDaemonRunning } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import {
  addRegistryToNpmrc,
  applySkipWorktree,
  ensureNpmrcForActiveRepos,
  installWithVersionUpdates,
  findCatalogRoot,
  findCatalogEntry,
  loadCatalogData,
} from "../lib/consumer";
import type { VersionEntry, CatalogFormat } from "../lib/consumer";
import {
  canonicalRepoPath,
  loadRepoByPath,
  saveRepoByPath,
} from "../lib/repo-state";
import {
  getDistTags,
  listPackageNames,
} from "../lib/registry";
import { sanitizeTag, ispkglabVersion, extractTag } from "../lib/version";
import { join, resolve, relative } from "node:path";
import { detectPackageManager } from "../lib/pm-detect";
import { discoverWorkspace } from "../lib/workspace";
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

const NPMRC_NOTICE =
  "notice: pkglab added registry entries to .npmrc\n" +
  "These entries point to localhost and will break CI if committed.\n" +
  "pkglab has applied --skip-worktree to prevent accidental commits.\n" +
  "Run pkglab restore --all to restore your .npmrc.";

async function batchInstallPackages(
  config: pkglabConfig,
  repoPath: string,
  packages: ResolvedPackage[],
  catalog?: boolean,
  packagejson?: string,
): Promise<void> {
  let effectivePath = repoPath;
  let catalogRoot: string | undefined;
  let catalogFormat: CatalogFormat | undefined;
  const catalogNames = new Map<string, string>(); // pkg name -> catalogName
  const packageJsonDir = packagejson ? resolve(repoPath, packagejson) : undefined;
  const pkgJsonTarget = packageJsonDir ?? repoPath;

  // Phase 1: Catalog detection (always try, --catalog makes it strict)
  const found = await findCatalogRoot(repoPath);
  if (found) {
    const data = await loadCatalogData(found.root, found.format);
    for (const pkg of packages) {
      const entry = findCatalogEntry(data, pkg.name);
      if (entry) {
        catalogNames.set(pkg.name, entry.catalogName);
        if (!catalog) {
          log.dim(`  auto-detected catalog for ${pkg.name}`);
        }
      } else if (catalog) {
        const source = found.format === "pnpm-workspace" ? "pnpm-workspace.yaml" : "workspace root package.json";
        log.error(`${pkg.name} is not in any catalog. Add it to the catalog field in ${source} first.`);
        process.exit(1);
      }
    }
    if (catalogNames.size > 0) {
      catalogRoot = found.root;
      catalogFormat = found.format;
      effectivePath = found.root;
    }
  } else if (catalog) {
    log.error("No catalog found. The workspace root needs a 'catalog' or 'catalogs' field in package.json or pnpm-workspace.yaml.");
    process.exit(1);
  }

  // Stale deps detection: always scan the target package.json for stale pkglab versions
  {
    const batchNames = new Set(packages.map((p) => p.name));
    const pkgJson = await Bun.file(join(pkgJsonTarget, "package.json")).json();
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
  }

  // Phase 2: npmrc setup (shared)
  const { isFirstTime } = await addRegistryToNpmrc(effectivePath, config.port);
  if (isFirstTime) {
    await applySkipWorktree(effectivePath);
    log.info(NPMRC_NOTICE);
  }

  // Phase 3: Build version entries and install
  const relPackageJsonDir = packageJsonDir ? relative(effectivePath, packageJsonDir) : undefined;

  // When no -p flag, scan workspace packages to find all sub-packages that use each dep
  let workspacePackageJsons: Array<{ dir: string; relDir: string; packageJson: Record<string, any> }> | undefined;
  if (!packagejson) {
    try {
      const ws = await discoverWorkspace(effectivePath);
      // Include root package.json plus all workspace packages
      const rootPkgJson = await Bun.file(join(effectivePath, "package.json")).json();
      workspacePackageJsons = [
        { dir: effectivePath, relDir: ".", packageJson: rootPkgJson },
        ...ws.packages
          .filter(p => p.dir !== effectivePath && p.dir !== ws.root)
          .map(p => ({
            dir: p.dir,
            relDir: relative(effectivePath, p.dir) || ".",
            packageJson: p.packageJson,
          })),
      ];
    } catch {
      // Not a workspace (standalone project), fall back to root only
    }
  }

  const entries: VersionEntry[] = packages.map(pkg => {
    const catalogName = catalogNames.get(pkg.name);

    let targets: Array<{ dir: string }>;
    if (packagejson) {
      // Explicit -p flag: single target, no scanning
      targets = [{ dir: relPackageJsonDir ?? "." }];
    } else if (workspacePackageJsons) {
      // Scan workspace packages for this dep
      const found: Array<{ dir: string }> = [];
      for (const wsPkg of workspacePackageJsons) {
        for (const field of ["dependencies", "devDependencies"] as const) {
          const deps = wsPkg.packageJson[field];
          if (!deps || !(pkg.name in deps)) continue;
          const depVersion = deps[pkg.name];
          if (typeof depVersion === "string" && depVersion.startsWith("catalog:")) continue;
          found.push({ dir: wsPkg.relDir });
          break; // found in this package, no need to check devDependencies too
        }
      }
      if (found.length > 1) {
        const dirs = found.map(t => t.dir).join(", ");
        log.dim(`  found ${pkg.name} in ${dirs}`);
      }
      targets = found.length > 0 ? found : [{ dir: "." }];
    } else {
      // Standalone project, single target at root
      targets = [{ dir: "." }];
    }

    return {
      name: pkg.name,
      version: pkg.version,
      ...(catalogName && { catalogName }),
      ...(catalogName && catalogFormat && { catalogFormat }),
      targets,
    };
  });

  const pm = await detectPackageManager(effectivePath);
  const previousVersions = await installWithVersionUpdates({
    repoPath: effectivePath,
    catalogRoot,
    entries,
    pm,
    onCommand: (cmd) => log.dim(`  ${cmd.join(" ")}`),
  });

  // Phase 4: Repo state update (shared)
  let repoState: RepoState = (await loadRepoByPath(effectivePath)) || {
    path: effectivePath,
    active: false,
    packages: {},
  };

  for (const pkg of packages) {
    const catalogName = catalogNames.get(pkg.name);
    const targets = previousVersions.get(pkg.name) ?? [{ dir: relPackageJsonDir ?? ".", original: "" }];
    if (!repoState.packages[pkg.name]) {
      repoState.packages[pkg.name] = {
        current: pkg.version,
        tag: pkg.tag,
        ...(catalogName && { catalogName }),
        ...(catalogFormat && { catalogFormat }),
        targets,
      };
    } else {
      repoState.packages[pkg.name].current = pkg.version;
      repoState.packages[pkg.name].tag = pkg.tag;
      if (catalogName) repoState.packages[pkg.name].catalogName = catalogName;
      if (catalogFormat) repoState.packages[pkg.name].catalogFormat = catalogFormat;
      repoState.packages[pkg.name].targets = targets;
    }
  }

  repoState.active = true;
  repoState.lastUsed = Date.now();
  await saveRepoByPath(effectivePath, repoState);

  // Phase 5: Success logging
  for (const { name, version } of packages) {
    const isCatalog = catalogNames.has(name);
    log.success(`Installed ${name}@${version}${isCatalog ? " (catalog)" : ""}`);
  }
}

async function interactivePick(fixedTag?: string): Promise<ResolvedPackage[]> {
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
    }

    if (fixedTag) {
      resolved.push(resolveFromDistTags(pkgName, distTags, fixedTag));
      continue;
    }

    if (tags.length === 1) {
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

function normalizeScope(input: string): string {
  const stripped = input.startsWith("@") ? input.slice(1) : input;
  if (!stripped || stripped.includes("/")) {
    log.error(`Invalid scope: "${input}". Use a scope name like "clerk" or "@clerk".`);
    process.exit(1);
  }
  return `@${stripped}/`;
}

async function resolveScopePackages(
  repoPath: string,
  scope: string,
  tag: string | undefined,
): Promise<ResolvedPackage[]> {
  const prefix = normalizeScope(scope);

  // Scan workspace
  let allPackageJsons: Array<{ packageJson: Record<string, any> }>;
  try {
    const ws = await discoverWorkspace(repoPath);
    const rootPkgJson = await Bun.file(join(ws.root, "package.json")).json();
    allPackageJsons = [
      { packageJson: rootPkgJson },
      ...ws.packages
        .filter(p => p.dir !== ws.root)
        .map(p => ({ packageJson: p.packageJson })),
    ];
  } catch {
    log.error("--scope requires a workspace. No workspace detected.");
    process.exit(1);
  }

  // Collect unique dep names matching scope
  const scopedDeps = new Set<string>();
  for (const { packageJson } of allPackageJsons) {
    for (const field of ["dependencies", "devDependencies"] as const) {
      const deps = packageJson[field];
      if (!deps) continue;
      for (const depName of Object.keys(deps)) {
        if (depName.startsWith(prefix)) {
          const depVersion = deps[depName];
          // Skip catalog: protocol entries (handled by catalog auto-detection)
          if (typeof depVersion === "string" && depVersion.startsWith("catalog:")) continue;
          scopedDeps.add(depName);
        }
      }
    }
  }

  if (scopedDeps.size === 0) {
    log.error(`No dependencies matching scope '${prefix.slice(0, -1)}' found in workspace.`);
    process.exit(1);
  }

  // Check all are published, resolve versions
  const missing: string[] = [];
  const resolved: ResolvedPackage[] = [];

  for (const depName of scopedDeps) {
    const distTags = await getDistTags(depName);
    const distTagKey = tag ? sanitizeTag(tag) : "pkglab";
    const version = distTags[distTagKey];
    if (!version) {
      missing.push(depName);
    } else {
      resolved.push({ name: depName, version, tag: tag ? sanitizeTag(tag) : undefined });
    }
  }

  if (missing.length > 0) {
    log.error(
      `These packages are not published in the local registry:\n` +
      missing.map(n => `  ${n}`).join("\n") +
      `\nPublish them first: pkglab pub ${missing.join(" ")}`,
    );
    process.exit(1);
  }

  log.info(`Found ${resolved.length} packages matching ${prefix.slice(0, -1)}`);
  for (const pkg of resolved) {
    log.dim(`  ${pkg.name}@${pkg.version}`);
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
    packagejson: {
      type: "string",
      alias: "p",
      description: "Path to directory containing the target package.json (relative to cwd)",
    },
    tag: {
      type: "string",
      alias: "t",
      description: "Tag for all packages",
    },
    scope: {
      type: "string",
      description: "Add all published packages matching a scope (e.g. clerk or @clerk)",
    },
  },
  async run({ args }) {
    const config = await loadConfig();
    const names = ((args as any)._ as string[] | undefined) ?? [];
    const catalog = args.catalog as boolean;
    const packagejson = args.packagejson as string | undefined;
    const scope = args.scope as string | undefined;
    const tag = args.tag as string | undefined;

    // Validation
    if (scope && names.length > 0) {
      log.error("Cannot combine --scope with package names. Use one or the other.");
      process.exit(1);
    }
    if (scope && packagejson) {
      log.error("Cannot combine --scope with -p. Scope scans the entire workspace.");
      process.exit(1);
    }
    if (tag && names.length > 0) {
      const hasInlineTag = names.some(n => {
        const lastAt = n.lastIndexOf("@");
        return lastAt > 0 && n.slice(lastAt + 1).length > 0;
      });
      if (hasInlineTag) {
        log.error("Cannot combine --tag with inline @tag syntax. Use one or the other.");
        process.exit(1);
      }
    }

    const [, repoPath] = await Promise.all([
      ensureDaemonRunning(),
      canonicalRepoPath(process.cwd()),
    ]);

    let resolved: ResolvedPackage[];
    if (scope) {
      resolved = await resolveScopePackages(repoPath, scope, tag);
    } else if (names.length === 0) {
      resolved = await interactivePick(tag);
    } else {
      const parsed = names.map(parsePackageArg);
      const distTagResults = await Promise.all(parsed.map((p) => getDistTags(p.name)));
      resolved = parsed.map((p, i) => resolveFromDistTags(p.name, distTagResults[i], tag ?? p.tag));
    }

    if (resolved.length > 0) {
      await batchInstallPackages(config, repoPath, resolved, catalog, packagejson);
      await ensureNpmrcForActiveRepos(config.port);
    }
  },
});
