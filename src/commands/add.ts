import { defineCommand } from "citty";
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
import {
  getDistTags,
  listPackageNames,
} from "../lib/registry";
import { sanitizeTag } from "../lib/version";
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
    return;
  }

  for (const pkgName of selectedNames) {
    const distTags = await getDistTags(pkgName);
    const tags = Object.keys(distTags).filter((t) => t !== "latest");
    let selectedTag: string | undefined;

    if (tags.length === 0) {
      log.error(`No pkglab versions for ${pkgName}. Publish first.`);
      continue;
    } else if (tags.length === 1) {
      // Single tag: use it directly (could be "pkglab" or a named tag)
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

    const resolved = resolveFromDistTags(pkgName, distTags, selectedTag);
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
    const config = await loadConfig();

    if (!args.name) {
      const [status, repoPath] = await Promise.all([
        getDaemonStatus(),
        canonicalRepoPath(process.cwd()),
      ]);
      if (!status?.running) throw new DaemonNotRunningError();
      await interactiveAdd(config, repoPath);
      await ensureNpmrcForActiveRepos(config.port);
      return;
    }

    const { name: pkgName, tag } = parsePackageArg(args.name as string);
    const [status, repoPath, distTags] = await Promise.all([
      getDaemonStatus(),
      canonicalRepoPath(process.cwd()),
      getDistTags(pkgName),
    ]);
    if (!status?.running) throw new DaemonNotRunningError();

    const resolved = resolveFromDistTags(pkgName, distTags, tag);
    await installPackage(config, repoPath, resolved);
    await ensureNpmrcForActiveRepos(config.port);
  },
});
