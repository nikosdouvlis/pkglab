import { getPackages } from "@manypkg/get-packages";
import type { WorkspacePackage } from "../types";

export async function discoverWorkspace(cwd: string): Promise<{
  root: string;
  packages: WorkspacePackage[];
}> {
  const result = await getPackages(cwd);
  return {
    root: result.rootDir,
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
