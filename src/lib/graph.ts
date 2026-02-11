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
      ...pkg.packageJson.optionalDependencies,
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
  // Dependents removed by consumer-aware filtering (empty when no filter applied)
  skippedDependents: string[];
}

export function computeCascade(
  graph: DepGraph<WorkspacePackage>,
  changedPackages: string[],
  consumedPackages?: Set<string>,
): CascadeResult {
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  const closure = new Set<string>();
  // Track all possible dependents so we can report which ones were filtered
  const allPossibleDependents = consumedPackages ? new Set<string>() : null;

  for (const name of changedPackages) {
    closure.add(name);

    try {
      const directDeps = graph.directDependenciesOf(name).filter(
        (dep) => dep !== name
      );
      dependencies[name] = directDeps;
      // Include transitive dependencies in the publish set so that
      // workspace deps are published at the same pkglab version
      const allDeps = graph.dependenciesOf(name);
      for (const dep of allDeps) {
        closure.add(dep);
      }
    } catch {
      dependencies[name] = [];
    }

    try {
      const transitiveDependents = graph.dependantsOf(name);
      if (allPossibleDependents) {
        for (const d of transitiveDependents) allPossibleDependents.add(d);
      }

      if (consumedPackages) {
        // Keep dependents that are consumed by active repos OR already in the
        // closure (targets and their deps that happen to also be dependents)
        const filtered = transitiveDependents.filter(
          (d) => closure.has(d) || consumedPackages.has(d),
        );
        dependents[name] = filtered;
        for (const dep of filtered) {
          closure.add(dep);
        }
      } else {
        dependents[name] = transitiveDependents;
        for (const dep of transitiveDependents) {
          closure.add(dep);
        }
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

  // Close under deps: every publishable package in the set must have its workspace deps in the set.
  // Skip private packages: they'll be filtered out later and shouldn't drag in their sibling deps.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...closure]) {
      const pkg = graph.getNodeData(name);
      if (pkg.packageJson.private) continue;
      try {
        const deps = graph.dependenciesOf(name);
        for (const dep of deps) {
          if (!closure.has(dep)) {
            closure.add(dep);
            changed = true;
          }
        }
      } catch {}
    }
  }

  // Populate dependencies record for any packages added by the close-under-deps pass
  for (const name of closure) {
    if (!dependencies[name]) {
      try {
        dependencies[name] = graph.directDependenciesOf(name).filter(
          (dep) => dep !== name
        );
      } catch {
        dependencies[name] = [];
      }
    }
  }

  // Compute skipped dependents: those that would have been included without the filter
  // but ended up outside the closure (even after close-under-deps may have re-added some)
  const skippedDependents = allPossibleDependents
    ? [...allPossibleDependents]
        .filter((d) => !closure.has(d))
        .filter((d) => !graph.getNodeData(d).packageJson.private)
        .sort()
    : [];

  // Deterministic toposort with lexical tie-breaking
  const ordered = deterministicToposort(graph, closure);
  if (ordered.length !== closure.size) {
    throw new CycleDetectedError(
      `Dependency cycle detected: toposort returned ${ordered.length} nodes but expected ${closure.size}`
    );
  }
  return {
    packages: ordered.map((name) => graph.getNodeData(name)),
    dependencies,
    dependents,
    skippedDependents,
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
