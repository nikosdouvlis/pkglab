import { mkdir } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { paths } from "./paths";
import type { PkglConfig } from "../types";

const DEFAULT_CONFIG: PkglConfig = {
  port: 4873,
  prune_keep: 3,
};

export async function ensurePkglDirs(): Promise<void> {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.reposDir, { recursive: true });
  await mkdir(paths.verdaccioDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
}

export async function loadConfig(): Promise<PkglConfig> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) {
    return { ...DEFAULT_CONFIG };
  }
  const text = await file.text();
  const parsed = parse(text) as Partial<PkglConfig>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveConfig(config: PkglConfig): Promise<void> {
  await Bun.write(paths.config, stringify(config));
}
