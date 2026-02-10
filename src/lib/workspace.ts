import { join } from "node:path";
import { getPackages } from "@manypkg/get-packages";
import type { WorkspacePackage } from "../types";

export type WorkspaceTool = "pnpm" | "yarn" | "npm" | "bolt" | "lerna" | "rush" | "root";

export async function discoverWorkspace(cwd: string): Promise<{
  root: string;
  tool: WorkspaceTool;
  packages: WorkspacePackage[];
}> {
  const result = await getPackages(cwd);
  return {
    root: result.rootDir,
    tool: result.tool.type as WorkspaceTool,
    packages: result.packages.map((pkg) => ({
      name: pkg.packageJson.name,
      dir: pkg.dir,
      packageJson: pkg.packageJson as Record<string, any>,
    })),
  };
}

export function findPackage(
  packages: WorkspacePackage[],
  name: string
): WorkspacePackage | undefined {
  return packages.find((p) => p.name === name);
}

export async function loadCatalogs(
  workspaceRoot: string
): Promise<Record<string, Record<string, string>>> {
  const file = Bun.file(join(workspaceRoot, "pnpm-workspace.yaml"));
  if (!(await file.exists())) return {};

  const { parse } = await import("yaml");
  const content = parse(await file.text());
  if (!content?.catalogs || typeof content.catalogs !== "object") return {};

  const result: Record<string, Record<string, string>> = {};
  for (const [name, entries] of Object.entries(content.catalogs)) {
    if (entries && typeof entries === "object") {
      result[name] = entries as Record<string, string>;
    }
  }
  return result;
}
