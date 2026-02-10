import { checkbox } from "@inquirer/prompts";
import { loadAllRepos } from "./repo-state";
import { log } from "./log";
import type { RepoState } from "../types";

export interface RepoChoice {
  name: string;
  state: RepoState;
}

export async function selectRepos(opts: {
  message: string;
  filter?: (state: RepoState) => boolean;
  emptyMessage?: string;
}): Promise<RepoChoice[]> {
  const all = await loadAllRepos();
  const entries = Object.entries(all);

  if (entries.length === 0) {
    log.info(opts.emptyMessage ?? "No repos linked. Use pkglab add in a consumer repo.");
    return [];
  }

  const filtered = (
    opts.filter
      ? entries.filter(([_, state]) => opts.filter!(state))
      : entries
  ).sort(([, a], [, b]) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));

  if (filtered.length === 0) {
    log.info(opts.emptyMessage ?? "No matching repos.");
    return [];
  }

  const selected = await checkbox({
    message: opts.message,
    choices: filtered.map(([name, state]) => {
      const pkgs = Object.keys(state.packages);
      const description = pkgs.length > 0 ? pkgs.join(", ") : "no packages";
      return { value: name, name: `${name} ${state.path}`, description };
    }),
  });

  return selected.map((name) => ({ name, state: all[name] }));
}
