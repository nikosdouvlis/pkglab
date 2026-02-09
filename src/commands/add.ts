import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import {
  addRegistryToNpmrc,
  applySkipWorktree,
  scopedInstall,
  updatePackageJsonVersion,
} from "../lib/consumer";
import {
  canonicalRepoPath,
  repoFileName,
  loadRepoState,
  saveRepoState,
} from "../lib/repo-state";
import { getPackageVersions } from "../lib/registry";
import { isPkglVersion, extractTimestamp } from "../lib/version";
import { log } from "../lib/log";
import { DaemonNotRunningError } from "../lib/errors";

export default defineCommand({
  meta: { name: "add", description: "Add a pkgl package to this repo" },
  args: {
    name: { type: "positional", description: "Package name", required: true },
  },
  async run({ args }) {
    const status = await getDaemonStatus();
    if (!status?.running) throw new DaemonNotRunningError();

    const config = await loadConfig();
    const repoPath = await canonicalRepoPath(process.cwd());
    const pkgName = args.name as string;

    const versions = await getPackageVersions(config, pkgName);
    const pkglVersions = versions
      .filter(isPkglVersion)
      .sort((a, b) => extractTimestamp(b) - extractTimestamp(a));

    if (pkglVersions.length === 0) {
      log.error(`No pkgl versions for ${pkgName}. Publish first: pkgl pub ${pkgName}`);
      process.exit(1);
    }

    const latestVersion = pkglVersions[0];

    const { isFirstTime } = await addRegistryToNpmrc(repoPath, config.port);
    if (isFirstTime) {
      await applySkipWorktree(repoPath);
      log.info(
        "notice: pkgl added registry entries to .npmrc\n" +
        "These entries point to localhost and will break CI if committed.\n" +
        "pkgl has applied --skip-worktree to prevent accidental commits.\n" +
        "Run pkgl rm to restore your .npmrc."
      );
    }

    const { previousVersion } = await updatePackageJsonVersion(
      repoPath,
      pkgName,
      latestVersion
    );
    await scopedInstall(repoPath, pkgName, latestVersion);

    const repoFile = await repoFileName(repoPath);
    let repoState = (await loadRepoState(repoFile)) || {
      path: repoPath,
      active: false,
      packages: {},
    };

    if (!repoState.packages[pkgName]) {
      repoState.packages[pkgName] = {
        original: previousVersion,
        current: latestVersion,
      };
    } else {
      repoState.packages[pkgName].current = latestVersion;
    }

    await saveRepoState(repoFile, repoState);
    log.success(`Installed ${pkgName}@${latestVersion}`);
  },
});
