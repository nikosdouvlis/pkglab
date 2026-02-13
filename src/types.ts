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
  current: string;
  tag?: string;
  catalogName?: string; // "default" for catalog field, other string for catalogs[name]
  catalogFormat?: "package-json" | "pnpm-workspace";
  targets: Array<{ dir: string; original: string }>;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  packageJson: Record<string, any>;
  publishable: boolean;
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
