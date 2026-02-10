import { defineCommand } from "citty";
import { select } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import { filterableCheckbox } from "../lib/prompt";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import {
  addRegistryToNpmrc,
  applySkipWorktree,
  ensureNpmrcForActiveRepos,
  scopedInstall,
  updatePackageJsonVersion,
} from "../lib/consumer";
import {
  canonicalRepoPath,
  repoFileName,
  loadRepoState,
  saveRepoState,
} from "../lib/repo-state";
import { getPackageVersions, listAllPackages } from "../lib/registry";
import {
  ispkglabVersion,
  extractTimestamp,
  extractTag,
  sanitizeTag,
} from "../lib/version";
import { log } from "../lib/log";
import { c } from "../lib/color";
import { DaemonNotRunningError } from "../lib/errors";
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

function resolveVersion(
  pkgName: string,
  allVersions: string[],
  requestedTag?: string,
): ResolvedPackage {
  const allPkglabVersions = allVersions.filter(ispkglabVersion);

  if (allPkglabVersions.length === 0) {
    log.error(
      `No pkglab versions for ${pkgName}. Publish first: pkglab pub ${pkgName}`,
    );
    process.exit(1);
  }

  const sanitizedTag = requestedTag ? sanitizeTag(requestedTag) : undefined;

  // Filter by tag: match sanitized tag, or null for untagged
  const filtered = allPkglabVersions
    .filter((v) => {
      const vTag = extractTag(v);
      if (sanitizedTag) return vTag === sanitizedTag;
      return vTag === null;
    })
    .sort((a, b) => extractTimestamp(b) - extractTimestamp(a));

  if (filtered.length === 0) {
    const availableTags = [
      ...new Set(allPkglabVersions.map(extractTag).filter(Boolean)),
    ] as string[];
    const hasUntagged = allPkglabVersions.some((v) => extractTag(v) === null);

    if (sanitizedTag) {
      const tagNote =
        sanitizedTag !== requestedTag
          ? ` (sanitized from '${requestedTag}')`
          : "";
      const tagList = availableTags.length
        ? availableTags.join(", ")
        : "(none)";
      const untaggedNote = hasUntagged ? " Also has untagged versions." : "";
      log.error(
        `No versions found for '${pkgName}' with tag '${sanitizedTag}'${tagNote}. Available tags: ${tagList}.${untaggedNote}`,
      );
    } else {
      const tagList = availableTags.join(", ");
      log.error(
        `No untagged versions for '${pkgName}'. Available tags: ${tagList}`,
      );
    }
    process.exit(1);
  }

  return {
    name: pkgName,
    version: filtered[0],
    tag: sanitizedTag,
  };
}

async function installPackage(
  config: pkglabConfig,
  repoPath: string,
  resolved: ResolvedPackage,
): Promise<void> {
  const { name, version, tag } = resolved;

  const { isFirstTime } = await addRegistryToNpmrc(repoPath, config.port);
  if (isFirstTime) {
    await applySkipWorktree(repoPath);
    log.info(
      "notice: pkglab added registry entries to .npmrc\n" +
        "These entries point to localhost and will break CI if committed.\n" +
        "pkglab has applied --skip-worktree to prevent accidental commits.\n" +
        "Run pkglab rm to restore your .npmrc.",
    );
  }

  const { previousVersion } = await updatePackageJsonVersion(
    repoPath,
    name,
    version,
  );
  await scopedInstall(repoPath, name, version);

  const repoFile = await repoFileName(repoPath);
  let repoState: RepoState = (await loadRepoState(repoFile)) || {
    path: repoPath,
    active: false,
    packages: {},
  };

  if (!repoState.packages[name]) {
    repoState.packages[name] = {
      original: previousVersion,
      current: version,
      tag,
    };
  } else {
    repoState.packages[name].current = version;
    repoState.packages[name].tag = tag;
  }

  repoState.active = true;
  repoState.lastUsed = Date.now();
  await saveRepoState(repoFile, repoState);
  log.success(`Installed ${name}@${version}`);
}

async function interactiveAdd(
  config: pkglabConfig,
  repoPath: string,
): Promise<void> {
  const allPackages = await listAllPackages(config);
  const pkglabPackages = allPackages.filter((pkg) =>
    pkg.versions.some(ispkglabVersion),
  );

  if (pkglabPackages.length === 0) {
    log.error("No pkglab packages found. Publish first: pkglab pub");
    process.exit(1);
  }

  let selectedNames: string[];
  try {
    selectedNames = await filterableCheckbox({
      message: "Select packages to add:",
      choices: pkglabPackages.map((pkg) => ({
        name: pkg.name,
        value: pkg.name,
      })),
    });
  } catch (err) {
    if (err instanceof ExitPromptError) process.exit(0);
    throw err;
  }

  if (selectedNames.length === 0) {
    log.dim("No packages selected.");
    return;
  }

  for (const pkgName of selectedNames) {
    const pkg = pkglabPackages.find((p) => p.name === pkgName)!;
    const pkglabVersions = pkg.versions.filter(ispkglabVersion);
    const tags = [...new Set(pkglabVersions.map(extractTag))];

    let selectedTag: string | null;

    if (tags.length === 1) {
      selectedTag = tags[0];
    } else {
      try {
        selectedTag = await select<string | null>({
          message: `Tag for ${pkgName}:`,
          choices: tags.map((t) => ({
            name: t ?? c.dim("(untagged)"),
            value: t,
          })),
        });
      } catch (err) {
        if (err instanceof ExitPromptError) process.exit(0);
        throw err;
      }
    }

    const resolved = resolveVersion(
      pkgName,
      pkg.versions,
      selectedTag ?? undefined,
    );
    await installPackage(config, repoPath, resolved);
  }
}

export default defineCommand({
  meta: { name: "add", description: "Add a pkglab package to this repo" },
  args: {
    name: {
      type: "positional",
      description: "Package name or name@tag",
      required: false,
    },
  },
  async run({ args }) {
    const status = await getDaemonStatus();
    if (!status?.running) throw new DaemonNotRunningError();

    const config = await loadConfig();
    const repoPath = await canonicalRepoPath(process.cwd());

    if (!args.name) {
      await interactiveAdd(config, repoPath);
      await ensureNpmrcForActiveRepos(config.port);
      return;
    }

    const { name: pkgName, tag } = parsePackageArg(args.name as string);
    const versions = await getPackageVersions(config, pkgName);
    const resolved = resolveVersion(pkgName, versions, tag);

    await installPackage(config, repoPath, resolved);
    await ensureNpmrcForActiveRepos(config.port);
  },
});
