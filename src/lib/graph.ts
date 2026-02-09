import { DepGraph } from "dependency-graph";
import type { WorkspacePackage } from "../types";
import { CycleDetectedError } from "./errors";

export function buildDependencyGraph(
  packages: WorkspacePackage[]
): DepGraph<WorkspacePackage> {
  const graph = new DepGraph<WorkspacePackage>();
  const names = new Set(packages.map((p) => p.name));

  for (const pkg of packages) {
    graph.addNode(pkg.name, pkg);
  }

  for (const pkg of packages) {
    const allDeps: Record<string, string> = {
      ...pkg.packageJson.dependencies,
      ...pkg.packageJson.peerDependencies,
    };
    for (const depName of Object.keys(allDeps)) {
      if (names.has(depName)) {
        graph.addDependency(pkg.name, depName);
      }
    }
  }

  return graph;
}

export function computeCascade(
  graph: DepGraph<WorkspacePackage>,
  changedPackages: string[]
): WorkspacePackage[] {
  const closure = new Set<string>();

  for (const name of changedPackages) {
    closure.add(name);
    try {
      for (const dep of graph.dependantsOf(name)) {
        closure.add(dep);
      }
    } catch (err: any) {
      if (err.cyclePath) {
        throw new CycleDetectedError(
          `Dependency cycle detected: ${err.cyclePath.join(" -> ")}`
        );
      }
      throw err;
    }
  }

  const expanded = new Set(closure);
  for (const name of closure) {
    try {
      for (const dep of graph.dependenciesOf(name)) {
        expanded.add(dep);
      }
    } catch (err: any) {
      if (err.cyclePath) {
        throw new CycleDetectedError(
          `Dependency cycle detected: ${err.cyclePath.join(" -> ")}`
        );
      }
      throw err;
    }
  }

  const fullOrder = graph.overallOrder();
  const ordered = fullOrder.filter((name) => expanded.has(name));
  return ordered.map((name) => graph.getNodeData(name));
}
