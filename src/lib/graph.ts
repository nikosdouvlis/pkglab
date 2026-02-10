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

export interface CascadeResult {
  packages: WorkspacePackage[];
  // Per-target: direct workspace dependencies
  dependencies: Record<string, string[]>;
  // Per-target: transitive dependents (packages that depend on the target)
  dependents: Record<string, string[]>;
}

export function computeCascade(
  graph: DepGraph<WorkspacePackage>,
  changedPackages: string[]
): CascadeResult {
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  const closure = new Set<string>();

  for (const name of changedPackages) {
    closure.add(name);

    try {
      dependencies[name] = graph.directDependenciesOf(name).filter(
        (dep) => dep !== name
      );
    } catch {
      dependencies[name] = [];
    }

    try {
      const transitiveDependents = graph.dependantsOf(name);
      dependents[name] = transitiveDependents;
      for (const dep of transitiveDependents) {
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

  // Deterministic toposort with lexical tie-breaking
  const ordered = deterministicToposort(graph, expanded);
  return {
    packages: ordered.map((name) => graph.getNodeData(name)),
    dependencies,
    dependents,
  };
}

function deterministicToposort(
  graph: DepGraph<WorkspacePackage>,
  subset: Set<string>
): string[] {
  // Build in-degree map for the subset
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const name of subset) {
    inDegree.set(name, 0);
    adjList.set(name, []);
  }

  for (const name of subset) {
    try {
      for (const dep of graph.directDependenciesOf(name)) {
        if (subset.has(dep)) {
          adjList.get(dep)!.push(name);
          inDegree.set(name, (inDegree.get(name) || 0) + 1);
        }
      }
    } catch {
      // Skip nodes not in graph
    }
  }

  // Kahn's algorithm with lexical tie-breaking
  const queue = [...subset]
    .filter((n) => inDegree.get(n) === 0)
    .sort();
  const result: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);

    for (const dependent of (adjList.get(node) || []).sort()) {
      const newDeg = (inDegree.get(dependent) || 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position
        const idx = queue.findIndex((n) => n > dependent);
        if (idx === -1) queue.push(dependent);
        else queue.splice(idx, 0, dependent);
      }
    }
  }

  return result;
}
