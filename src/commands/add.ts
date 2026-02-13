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
  const entries: VersionEntry[] = packages.map(pkg => {
    const catalogName = catalogNames.get(pkg.name);
    return {
      name: pkg.name,
      version: pkg.version,
      ...(catalogName && { catalogName }),
      ...(catalogName && catalogFormat && { catalogFormat }),
      ...(relPackageJsonDir && { packageJsonDir: relPackageJsonDir }),
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
    if (!repoState.packages[pkg.name]) {
      repoState.packages[pkg.name] = {
        original: previousVersions.get(pkg.name) ?? "",
        current: pkg.version,
        tag: pkg.tag,
        ...(catalogName && { catalogName }),
        ...(catalogFormat && { catalogFormat }),
        ...(relPackageJsonDir && { packageJsonDir: relPackageJsonDir }),
      };
    } else {
      repoState.packages[pkg.name].current = pkg.version;
      repoState.packages[pkg.name].tag = pkg.tag;
      if (catalogName) repoState.packages[pkg.name].catalogName = catalogName;
      if (catalogFormat) repoState.packages[pkg.name].catalogFormat = catalogFormat;
      if (relPackageJsonDir) repoState.packages[pkg.name].packageJsonDir = relPackageJsonDir;
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
    packagejson: {
      type: "string",
      alias: "p",
      description: "Path to directory containing the target package.json (relative to cwd)",
    },
  },
  async run({ args }) {
    const config = await loadConfig();
    const names = ((args as any)._ as string[] | undefined) ?? [];
    const catalog = args.catalog as boolean;
    const packagejson = args.packagejson as string | undefined;

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
      await batchInstallPackages(config, repoPath, resolved, catalog, packagejson);
      await ensureNpmrcForActiveRepos(config.port);
    }
  },
});
