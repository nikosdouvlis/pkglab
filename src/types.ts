export interface pkglabConfig {
  port: number;
  prune_keep: number;
}

export interface RepoState {
  path: string;
  active: boolean;
  lastUsed?: number;
  packages: Record<string, PackageLink>;
}

export interface PackageLink {
  original: string;
  current: string;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  packageJson: Record<string, any>;
}

export interface PublishPlan {
  timestamp: number;
  packages: PublishEntry[];
  catalogs: Record<string, Record<string, string>>;
}

export interface PublishEntry {
  name: string;
  dir: string;
  version: string;
  rewrittenDeps: Record<string, string>;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  running: boolean;
}
