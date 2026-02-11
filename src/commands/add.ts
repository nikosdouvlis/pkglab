import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import {
  addRegistryToNpmrc,
  applySkipWorktree,
  ensureNpmrcForActiveRepos,
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
import { detectPackageManager, batchInstallCommand } from "../lib/pm-detect";
import { run } from "../lib/proc";
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

async function batchInstallPackages(
  config: pkglabConfig,
  repoPath: string,
  packages: ResolvedPackage[],
): Promise<void> {
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

  // Update all package.json versions before installing
  const prevVersions: { name: string; version: string }[] = [];
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
      await updatePackageJsonVersion(repoPath, prev.name, prev.version);
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

  // Resolve all packages (with tag prompts) before installing
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

  if (resolved.length > 0) {
    await batchInstallPackages(config, repoPath, resolved);
  }
}

export default defineCommand({
  meta: { name: "add", description: "Add a pkglab package to this repo" },
  args: {
    name: {
      type: "positional",
      description: "Package name(s) or name@tag",
      required: false,
    },
  },
  async run({ args }) {
    const config = await loadConfig();
    const names = ((args as any)._ as string[] | undefined) ?? [];

    if (names.length === 0) {
      const [status, repoPath] = await Promise.all([
        getDaemonStatus(),
        canonicalRepoPath(process.cwd()),
      ]);
      if (!status?.running) throw new DaemonNotRunningError();
      await interactiveAdd(config, repoPath);
      await ensureNpmrcForActiveRepos(config.port);
      return;
    }

    const parsed = names.map(parsePackageArg);
    const [status, repoPath, ...distTagResults] = await Promise.all([
      getDaemonStatus(),
      canonicalRepoPath(process.cwd()),
      ...parsed.map((p) => getDistTags(p.name)),
    ]);
    if (!status?.running) throw new DaemonNotRunningError();

    const resolved = parsed.map((p, i) =>
      resolveFromDistTags(p.name, distTagResults[i], p.tag),
    );

    await batchInstallPackages(config, repoPath, resolved);
    await ensureNpmrcForActiveRepos(config.port);
  },
});
