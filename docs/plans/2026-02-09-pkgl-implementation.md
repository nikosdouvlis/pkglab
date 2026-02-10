# pkglab implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Bun CLI that uses Verdaccio as a local npm registry to replace yalc for local package development.

**Architecture:** pkglab manages a local Verdaccio instance. Publisher repos publish packages to it with synthetic versions (0.0.0-pkglab.{timestamp}). Consumer repos install from it using their native PM. The cascade algorithm walks the workspace dep graph to ensure all affected packages are published atomically. State is stored in ~/.pkglab/ (YAML). No config files in repos.

**Tech Stack:** Bun, citty (CLI), picocolors (colors), yaml (parsing), @manypkg/get-packages (workspace discovery), dependency-graph (graph ops), verdaccio (registry), npm CLI (publish/unpublish)

**Design doc:** `docs/design.md`

---

## Task 1: project scaffolding

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `src/lib/paths.ts`
- Create: `src/lib/log.ts`
- Create: `src/lib/errors.ts`
- Create: `src/lib/config.ts`
- Create: `src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "pkglab",
  "version": "0.0.1",
  "type": "module",
  "bin": {
    "pkglab": "./src/index.ts"
  },
  "dependencies": {
    "citty": "^0.1",
    "picocolors": "^1.1",
    "yaml": "^2.7",
    "@manypkg/get-packages": "^2.2",
    "dependency-graph": "^1.0",
    "verdaccio": "^6",
    "libnpmpublish": "^10"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src"]
}
```

**Step 3: Create src/types.ts**

```typescript
export interface pkglabConfig {
  port: number;
  prune_keep: number;
}

export interface RepoState {
  path: string;
  active: boolean;
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
```

**Step 4: Create src/lib/paths.ts**

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

const pkglab_HOME = join(homedir(), ".pkglab");

export const paths = {
  home: pkglab_HOME,
  config: join(pkglab_HOME, "config.yaml"),
  pid: join(pkglab_HOME, "pid"),
  publishLock: join(pkglab_HOME, "publish.lock"),
  reposDir: join(pkglab_HOME, "repos"),
  verdaccioDir: join(pkglab_HOME, "verdaccio"),
  verdaccioConfig: join(pkglab_HOME, "verdaccio", "config.yaml"),
  verdaccioStorage: join(pkglab_HOME, "verdaccio", "storage"),
  logFile: "/tmp/pkglab/verdaccio.log",
  logDir: "/tmp/pkglab",
} as const;
```

**Step 5: Create src/lib/log.ts**

```typescript
import pc from "picocolors";

export const log = {
  info: (msg: string) => console.log(pc.blue("info"), msg),
  success: (msg: string) => console.log(pc.green("ok"), msg),
  warn: (msg: string) => console.log(pc.yellow("warn"), msg),
  error: (msg: string) => console.error(pc.red("error"), msg),
  dim: (msg: string) => console.log(pc.dim(msg)),
  line: (msg: string) => console.log(msg),
};
```

**Step 6: Create src/lib/errors.ts**

```typescript
export class pkglabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "pkglabError";
  }
}

export class DaemonNotRunningError extends pkglabError {
  constructor(msg = "Verdaccio is not running. Run: pkglab start") {
    super(msg);
    this.name = "DaemonNotRunningError";
  }
}

export class DaemonAlreadyRunningError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "DaemonAlreadyRunningError";
  }
}

export class PortInUseError extends pkglabError {
  constructor(port: number) {
    super(`Port ${port} is already in use`);
    this.name = "PortInUseError";
  }
}

export class LockAcquisitionError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "LockAcquisitionError";
  }
}

export class CycleDetectedError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "CycleDetectedError";
  }
}

export class NpmrcConflictError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "NpmrcConflictError";
  }
}

export class PackageManagerAmbiguousError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "PackageManagerAmbiguousError";
  }
}
```

**Step 7: Create src/lib/config.ts**

```typescript
import { mkdir } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { paths } from "./paths";
import type { pkglabConfig } from "../types";

const DEFAULT_CONFIG: pkglabConfig = {
  port: 4873,
  prune_keep: 3,
};

export async function ensurepkglabDirs(): Promise<void> {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.reposDir, { recursive: true });
  await mkdir(paths.verdaccioDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
}

export async function loadConfig(): Promise<pkglabConfig> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) {
    return { ...DEFAULT_CONFIG };
  }
  const text = await file.text();
  const parsed = parse(text) as Partial<pkglabConfig>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveConfig(config: pkglabConfig): Promise<void> {
  await Bun.write(paths.config, stringify(config));
}
```

**Step 8: Install dependencies**

Run: `cd /Users/nikos/Projects/pkglab && bun install`
Expected: lockfile created, node_modules populated

**Step 9: Commit**

```bash
git init
git add package.json tsconfig.json bun.lock src/types.ts src/lib/paths.ts src/lib/log.ts src/lib/errors.ts src/lib/config.ts
git commit -m "feat: project scaffolding with core lib modules"
```

---

## Task 2: CLI skeleton with all command stubs

**Files:**

- Create: `src/commands/start.ts`
- Create: `src/commands/stop.ts`
- Create: `src/commands/status.ts`
- Create: `src/commands/logs.ts`
- Create: `src/commands/pub.ts`
- Create: `src/commands/add.ts`
- Create: `src/commands/rm.ts`
- Create: `src/commands/doctor.ts`
- Create: `src/commands/prune.ts`
- Create: `src/commands/check.ts`
- Create: `src/commands/repos/index.ts`
- Create: `src/commands/repos/ls.ts`
- Create: `src/commands/repos/activate.ts`
- Create: `src/commands/repos/deactivate.ts`
- Create: `src/commands/repos/reset.ts`
- Create: `src/commands/repos/rename.ts`
- Create: `src/commands/pkgs/index.ts`
- Create: `src/commands/pkgs/ls.ts`
- Create: `src/index.ts`

**Step 1: Create all command stubs**

Each command stub follows this pattern (showing start.ts as example, repeat for all):

```typescript
// src/commands/start.ts
import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "start", description: "Start Verdaccio daemon" },
  run() {
    console.log("pkglab start: not implemented yet");
  },
});
```

Create stubs for: start, stop, status, logs, pub, add, rm, doctor, prune, check.

For pub.ts, include args in the stub:

```typescript
// src/commands/pub.ts
import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "pub", description: "Publish packages to local Verdaccio" },
  args: {
    name: { type: "positional", description: "Package name", required: false },
    "dry-run": {
      type: "boolean",
      description: "Show what would be published",
      default: false,
    },
    fast: { type: "boolean", description: "Skip dep cascade", default: false },
  },
  run() {
    console.log("pkglab pub: not implemented yet");
  },
});
```

For add.ts and rm.ts:

```typescript
// src/commands/add.ts
import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "add", description: "Add a pkglab package to this repo" },
  args: {
    name: { type: "positional", description: "Package name", required: true },
  },
  run() {
    console.log("pkglab add: not implemented yet");
  },
});
```

For logs.ts:

```typescript
// src/commands/logs.ts
import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "logs", description: "Tail Verdaccio logs" },
  args: {
    follow: {
      type: "boolean",
      alias: "f",
      description: "Stream logs",
      default: false,
    },
  },
  run() {
    console.log("pkglab logs: not implemented yet");
  },
});
```

For repos/reset.ts:

```typescript
// src/commands/repos/reset.ts
import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "reset", description: "Reset repo to original versions" },
  args: {
    name: { type: "positional", description: "Repo name", required: false },
    all: { type: "boolean", description: "Reset all repos", default: false },
  },
  run() {
    console.log("pkglab repos reset: not implemented yet");
  },
});
```

**Step 2: Create repos/index.ts with nested subcommands**

```typescript
// src/commands/repos/index.ts
import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "repos", description: "Manage linked consumer repos" },
  subCommands: {
    ls: () => import("./ls").then((m) => m.default),
    activate: () => import("./activate").then((m) => m.default),
    deactivate: () => import("./deactivate").then((m) => m.default),
    reset: () => import("./reset").then((m) => m.default),
    rename: () => import("./rename").then((m) => m.default),
  },
});
```

**Step 3: Create pkgs/index.ts**

```typescript
// src/commands/pkgs/index.ts
import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "pkgs", description: "Manage packages in Verdaccio" },
  subCommands: {
    ls: () => import("./ls").then((m) => m.default),
  },
});
```

**Step 4: Create src/index.ts entry point**

```typescript
#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { ensurepkglabDirs } from "./lib/config";

const main = defineCommand({
  meta: {
    name: "pkglab",
    version: "0.0.1",
    description: "Local package development with Verdaccio",
  },
  subCommands: {
    start: () => import("./commands/start").then((m) => m.default),
    stop: () => import("./commands/stop").then((m) => m.default),
    status: () => import("./commands/status").then((m) => m.default),
    logs: () => import("./commands/logs").then((m) => m.default),
    pub: () => import("./commands/pub").then((m) => m.default),
    add: () => import("./commands/add").then((m) => m.default),
    rm: () => import("./commands/rm").then((m) => m.default),
    repos: () => import("./commands/repos/index").then((m) => m.default),
    pkgs: () => import("./commands/pkgs/index").then((m) => m.default),
    doctor: () => import("./commands/doctor").then((m) => m.default),
    prune: () => import("./commands/prune").then((m) => m.default),
    check: () => import("./commands/check").then((m) => m.default),
  },
  async setup() {
    await ensurepkglabDirs();
  },
});

runMain(main);
```

**Step 5: Verify CLI works**

Run: `cd /Users/nikos/Projects/pkglab && bun link`
Expected: pkglab command available globally

Run: `pkglab`
Expected: help output with all commands listed

Run: `pkglab start`
Expected: "pkglab start: not implemented yet"

Run: `pkglab repos ls`
Expected: "pkglab repos ls: not implemented yet"

Run: `ls ~/.pkglab/`
Expected: repos/ verdaccio/ directories created

**Step 6: Commit**

```bash
git add src/
git commit -m "feat: CLI skeleton with all command stubs"
```

---

## Task 3: Verdaccio daemon management

**Files:**

- Create: `src/lib/verdaccio-config.ts`
- Create: `src/lib/verdaccio-worker.ts`
- Create: `src/lib/daemon.ts`
- Modify: `src/commands/start.ts`
- Modify: `src/commands/stop.ts`
- Modify: `src/commands/status.ts`
- Modify: `src/commands/logs.ts`

**Step 1: Create src/lib/verdaccio-config.ts**

```typescript
import { paths } from "./paths";
import type { pkglabConfig } from "../types";

export function buildVerdaccioConfig(config: pkglabConfig) {
  return {
    self_path: paths.verdaccioDir,
    storage: paths.verdaccioStorage,
    uplinks: {
      npmjs: {
        url: "https://registry.npmjs.org/",
        cache: true,
      },
    },
    packages: {
      "**": {
        access: "$all",
        publish: "$all",
        unpublish: "$all",
        proxy: "npmjs",
      },
    },
    server: { keepAliveTimeout: 60 },
    logs: { type: "file", path: paths.logFile, level: "info" },
    auth: {
      htpasswd: {
        file: paths.verdaccioDir + "/htpasswd",
        max_users: -1,
      },
    },
  };
}
```

**Step 2: Create src/lib/verdaccio-worker.ts**

This is spawned as a detached process. NOT imported by the main CLI.

```typescript
#!/usr/bin/env bun

import { runServer } from "verdaccio";
import { buildVerdaccioConfig } from "./verdaccio-config";
import { loadConfig, ensurepkglabDirs } from "./config";
import { mkdir } from "node:fs/promises";
import { paths } from "./paths";

async function main() {
  await ensurepkglabDirs();
  await mkdir(paths.verdaccioStorage, { recursive: true });

  const config = await loadConfig();
  const verdaccioConfig = buildVerdaccioConfig(config);

  const app = await runServer(verdaccioConfig);

  app.listen(config.port, "127.0.0.1", () => {
    process.stdout.write("READY\n");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Step 3: Create src/lib/daemon.ts**

```typescript
import { paths } from "./paths";
import { loadConfig } from "./config";
import { DaemonAlreadyRunningError } from "./errors";
import type { DaemonInfo } from "../types";

export async function startDaemon(): Promise<DaemonInfo> {
  const existing = await getDaemonStatus();
  if (existing?.running) {
    throw new DaemonAlreadyRunningError(
      `Already running on port ${existing.port} (PID ${existing.pid})`,
    );
  }

  // Clean stale PID if exists
  const pidFile = Bun.file(paths.pid);
  if (await pidFile.exists()) {
    const { unlink } = await import("node:fs/promises");
    await unlink(paths.pid);
  }

  const config = await loadConfig();
  const workerPath = new URL("./verdaccio-worker.ts", import.meta.url).pathname;

  const proc = Bun.spawn(["bun", workerPath], {
    stdout: "pipe",
    stderr: "pipe",
    // Note: Bun.spawn doesn't have a 'detached' option like Node.
    // The process will stay alive after parent exits because we unref it below.
  });

  // Wait for READY signal
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let ready = false;
  const timeout = setTimeout(() => {
    if (!ready) {
      proc.kill();
      throw new Error("Verdaccio failed to start within 10 seconds");
    }
  }, 10000);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    if (text.includes("READY")) {
      ready = true;
      clearTimeout(timeout);
      break;
    }
  }

  // Write PID
  await Bun.write(paths.pid, String(proc.pid));

  // Unref so parent can exit
  proc.unref();

  return { pid: proc.pid, port: config.port, running: true };
}

export async function stopDaemon(): Promise<void> {
  const status = await getDaemonStatus();
  if (!status?.running) return;

  process.kill(status.pid, "SIGTERM");

  // Wait for process to exit
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(250);
    if (!isProcessAlive(status.pid)) break;
  }

  // Force kill if still alive
  if (isProcessAlive(status.pid)) {
    process.kill(status.pid, "SIGKILL");
  }

  const { unlink } = await import("node:fs/promises");
  await unlink(paths.pid).catch(() => {});
}

export async function getDaemonStatus(): Promise<DaemonInfo | null> {
  const pidFile = Bun.file(paths.pid);
  if (!(await pidFile.exists())) return null;

  const pidStr = await pidFile.text();
  const pid = parseInt(pidStr.trim(), 10);
  if (isNaN(pid)) return null;

  if (!isProcessAlive(pid)) {
    // Stale PID, clean up
    const { unlink } = await import("node:fs/promises");
    await unlink(paths.pid).catch(() => {});
    return null;
  }

  if (!(await validatePid(pid))) {
    return null;
  }

  const config = await loadConfig();
  return { pid, port: config.port, running: true };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function validatePid(pid: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    return output.includes("verdaccio-worker") || output.includes("verdaccio");
  } catch {
    return false;
  }
}
```

**Step 4: Implement src/commands/start.ts**

```typescript
import { defineCommand } from "citty";
import { startDaemon, getDaemonStatus } from "../lib/daemon";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "start", description: "Start Verdaccio daemon" },
  async run() {
    const existing = await getDaemonStatus();
    if (existing?.running) {
      log.warn(
        `Already running on port ${existing.port} (PID ${existing.pid})`,
      );
      return;
    }

    log.info("Starting Verdaccio...");
    const info = await startDaemon();
    log.success(
      `pkglab running on http://127.0.0.1:${info.port} (PID ${info.pid})`,
    );
  },
});
```

**Step 5: Implement src/commands/stop.ts**

```typescript
import { defineCommand } from "citty";
import { stopDaemon, getDaemonStatus } from "../lib/daemon";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "stop", description: "Stop Verdaccio daemon" },
  async run() {
    const status = await getDaemonStatus();
    if (!status?.running) {
      log.warn("Verdaccio is not running");
      return;
    }
    await stopDaemon();
    log.success("Verdaccio stopped");
  },
});
```

**Step 6: Implement src/commands/status.ts**

```typescript
import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "status", description: "Show server info and status" },
  async run() {
    const config = await loadConfig();
    const status = await getDaemonStatus();

    if (status?.running) {
      log.success(
        `Verdaccio running on http://127.0.0.1:${config.port} (PID ${status.pid})`,
      );
    } else {
      log.info("Verdaccio is not running");
    }
  },
});
```

**Step 7: Implement src/commands/logs.ts**

```typescript
import { defineCommand } from "citty";
import { paths } from "../lib/paths";
import { log } from "../lib/log";

export default defineCommand({
  meta: { name: "logs", description: "Tail Verdaccio logs" },
  args: {
    follow: {
      type: "boolean",
      alias: "f",
      description: "Stream logs",
      default: false,
    },
  },
  async run({ args }) {
    const file = Bun.file(paths.logFile);
    if (!(await file.exists())) {
      log.warn("No log file found. Has Verdaccio been started?");
      return;
    }

    const cmd = args.follow
      ? ["tail", "-f", paths.logFile]
      : ["tail", "-50", paths.logFile];

    const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
    await proc.exited;
  },
});
```

**Step 8: Verify daemon lifecycle**

Run: `pkglab start`
Expected: "pkglab running on http://127.0.0.1:4873 (PID XXXX)"

Run: `curl -s http://localhost:4873 | head -c 100`
Expected: Verdaccio HTML or JSON response

Run: `pkglab status`
Expected: "Verdaccio running on ..."

Run: `pkglab logs`
Expected: log output

Run: `pkglab start`
Expected: "Already running..."

Run: `pkglab stop`
Expected: "Verdaccio stopped"

Run: `pkglab status`
Expected: "Verdaccio is not running"

**Step 9: Commit**

```bash
git add src/lib/verdaccio-config.ts src/lib/verdaccio-worker.ts src/lib/daemon.ts src/commands/start.ts src/commands/stop.ts src/commands/status.ts src/commands/logs.ts
git commit -m "feat: Verdaccio daemon management (start/stop/status/logs)"
```

---

## Task 4: version generation and workspace discovery

**Files:**

- Create: `src/lib/version.ts`
- Create: `src/lib/workspace.ts`

**Step 1: Create src/lib/version.ts**

```typescript
const VERSION_PREFIX = "0.0.0-pkglab.";
let lastTimestamp = 0;

export function generateVersion(): string {
  const now = Date.now();
  const ts = Math.max(lastTimestamp + 1, now);
  lastTimestamp = ts;
  return `${VERSION_PREFIX}${ts}`;
}

export function ispkglabVersion(version: string): boolean {
  return version.startsWith(VERSION_PREFIX);
}

export function extractTimestamp(version: string): number {
  return parseInt(version.slice(VERSION_PREFIX.length), 10);
}
```

**Step 2: Create src/lib/workspace.ts**

```typescript
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
  name: string,
): WorkspacePackage | undefined {
  return packages.find((p) => p.name === name);
}
```

**Step 3: Commit**

```bash
git add src/lib/version.ts src/lib/workspace.ts
git commit -m "feat: version generation and workspace discovery"
```

---

## Task 5: dependency graph and cascade algorithm

**Files:**

- Create: `src/lib/graph.ts`

**Step 1: Create src/lib/graph.ts**

```typescript
import { DepGraph } from "dependency-graph";
import type { WorkspacePackage } from "../types";
import { CycleDetectedError } from "./errors";

export function buildDependencyGraph(
  packages: WorkspacePackage[],
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
  changedPackages: string[],
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
          `Dependency cycle detected: ${err.cyclePath.join(" -> ")}`,
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
          `Dependency cycle detected: ${err.cyclePath.join(" -> ")}`,
        );
      }
      throw err;
    }
  }

  const fullOrder = graph.overallOrder();
  const ordered = fullOrder.filter((name) => expanded.has(name));
  return ordered.map((name) => graph.getNodeData(name));
}
```

**Step 2: Commit**

```bash
git add src/lib/graph.ts
git commit -m "feat: dependency graph with cascade algorithm"
```

---

## Task 6: publish mutex and publisher core

**Files:**

- Create: `src/lib/lock.ts`
- Create: `src/lib/publisher.ts`
- Create: `src/lib/registry.ts`

**Step 1: Create src/lib/lock.ts**

```typescript
import { paths } from "./paths";
import { LockAcquisitionError } from "./errors";
import { unlink } from "node:fs/promises";

export async function acquirePublishLock(): Promise<() => Promise<void>> {
  const lockPath = paths.publishLock;
  const file = Bun.file(lockPath);

  if (await file.exists()) {
    const content = await file.text();
    const holderPid = parseInt(content.trim(), 10);
    if (!isNaN(holderPid) && isProcessAlive(holderPid)) {
      throw new LockAcquisitionError(
        `Another pkglab pub is running (PID ${holderPid})`,
      );
    }
  }

  await Bun.write(lockPath, String(process.pid));

  return async () => {
    await unlink(lockPath).catch(() => {});
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

**Step 2: Create src/lib/registry.ts**

```typescript
import type { pkglabConfig } from "../types";

function registryUrl(config: pkglabConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

export async function getPackageVersions(
  config: pkglabConfig,
  name: string,
): Promise<string[]> {
  try {
    const url = `${registryUrl(config)}/${encodeURIComponent(name)}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    return Object.keys(data.versions || {});
  } catch {
    return [];
  }
}

export async function listAllPackages(
  config: pkglabConfig,
): Promise<Array<{ name: string; versions: string[] }>> {
  try {
    const url = `${registryUrl(config)}/-/verdaccio/data/sidebar/@*/*`;
    const resp = await fetch(`${registryUrl(config)}/-/verdaccio/packages`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    return data.map((pkg: any) => ({
      name: pkg.name,
      versions: Object.keys(pkg.versions || {}),
    }));
  } catch {
    return [];
  }
}

export async function unpublishVersion(
  config: pkglabConfig,
  name: string,
  version: string,
): Promise<void> {
  const proc = Bun.spawn(
    [
      "npm",
      "unpublish",
      `${name}@${version}`,
      "--registry",
      registryUrl(config),
      "--force",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Unpublish failed for ${name}@${version}: ${stderr}`);
  }
}
```

**Step 3: Create src/lib/publisher.ts**

```typescript
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cp, rm, mkdir } from "node:fs/promises";
import type {
  PublishPlan,
  PublishEntry,
  WorkspacePackage,
  pkglabConfig,
} from "../types";
import { log } from "./log";
import { DepGraph } from "dependency-graph";

export function buildPublishPlan(
  packages: WorkspacePackage[],
  version: string,
): PublishPlan {
  const publishNames = new Set(packages.map((p) => p.name));

  const entries: PublishEntry[] = packages.map((pkg) => {
    const rewrittenDeps: Record<string, string> = {};

    for (const field of ["dependencies", "peerDependencies"]) {
      const deps = pkg.packageJson[field];
      if (!deps) continue;
      for (const depName of Object.keys(deps)) {
        if (publishNames.has(depName)) {
          rewrittenDeps[depName] = version;
        }
      }
    }

    return { name: pkg.name, dir: pkg.dir, version, rewrittenDeps };
  });

  return { timestamp: Date.now(), packages: entries };
}

export async function executePublish(
  plan: PublishPlan,
  config: pkglabConfig,
): Promise<void> {
  const registryUrl = `http://127.0.0.1:${config.port}`;
  const published: string[] = [];

  try {
    for (const entry of plan.packages) {
      log.info(`Publishing ${entry.name}@${entry.version}`);
      await publishSinglePackage(entry, registryUrl);
      published.push(`${entry.name}@${entry.version}`);
    }
  } catch (err) {
    log.error("Publish failed, rolling back...");
    for (const spec of published) {
      await rollbackPackage(spec, registryUrl);
    }
    throw err;
  }
}

async function publishSinglePackage(
  entry: PublishEntry,
  registryUrl: string,
): Promise<void> {
  const safeName = entry.name.replace("/", "-").replace("@", "");
  const tempDir = join(tmpdir(), `pkglab-${safeName}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    await cp(entry.dir, tempDir, { recursive: true });

    const pkgJsonPath = join(tempDir, "package.json");
    const pkgJson = await Bun.file(pkgJsonPath).json();

    pkgJson.version = entry.version;

    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      if (!pkgJson[field]) continue;
      for (const [name, version] of Object.entries(pkgJson[field])) {
        if (entry.rewrittenDeps[name]) {
          pkgJson[field][name] = entry.rewrittenDeps[name];
        } else if (
          typeof version === "string" &&
          version.startsWith("workspace:")
        ) {
          pkgJson[field][name] = (version as string).replace("workspace:", "");
        }
      }
    }

    // Strip workspace protocol from devDependencies too (they go into published manifest)
    if (pkgJson.devDependencies) {
      for (const [name, version] of Object.entries(pkgJson.devDependencies)) {
        if (typeof version === "string" && version.startsWith("workspace:")) {
          pkgJson.devDependencies[name] = (version as string).replace(
            "workspace:",
            "",
          );
        }
      }
    }

    await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

    // Remove node_modules from temp dir if copied
    await rm(join(tempDir, "node_modules"), { recursive: true, force: true });

    const proc = Bun.spawn(
      [
        "npm",
        "publish",
        "--registry",
        registryUrl,
        "--no-git-checks",
        "--access",
        "public",
      ],
      { cwd: tempDir, stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`npm publish failed for ${entry.name}: ${stderr}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function rollbackPackage(
  spec: string,
  registryUrl: string,
): Promise<void> {
  try {
    const proc = Bun.spawn(
      ["npm", "unpublish", spec, "--registry", registryUrl, "--force"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
  } catch {
    log.warn(`Failed to rollback ${spec}`);
  }
}
```

**Step 4: Commit**

```bash
git add src/lib/lock.ts src/lib/registry.ts src/lib/publisher.ts
git commit -m "feat: publish mutex, registry client, and publisher core"
```

---

## Task 7: pub command implementation

**Files:**

- Modify: `src/commands/pub.ts`

**Step 1: Implement pub command**

```typescript
import { defineCommand } from "citty";
import { getDaemonStatus } from "../lib/daemon";
import { loadConfig } from "../lib/config";
import { discoverWorkspace, findPackage } from "../lib/workspace";
import { buildDependencyGraph, computeCascade } from "../lib/graph";
import { buildPublishPlan, executePublish } from "../lib/publisher";
import { generateVersion } from "../lib/version";
import { acquirePublishLock } from "../lib/lock";
import { log } from "../lib/log";
import { DaemonNotRunningError } from "../lib/errors";

export default defineCommand({
  meta: { name: "pub", description: "Publish packages to local Verdaccio" },
  args: {
    name: { type: "positional", description: "Package name", required: false },
    "dry-run": {
      type: "boolean",
      description: "Show what would be published",
      default: false,
    },
    fast: { type: "boolean", description: "Skip dep cascade", default: false },
  },
  async run({ args }) {
    const status = await getDaemonStatus();
    if (!status?.running) {
      throw new DaemonNotRunningError();
    }

    const config = await loadConfig();
    const workspace = await discoverWorkspace(process.cwd());
    log.info(`Found ${workspace.packages.length} packages in workspace`);

    const graph = buildDependencyGraph(workspace.packages);

    let targets: string[];
    if (args.name) {
      const pkg = findPackage(workspace.packages, args.name as string);
      if (!pkg) {
        log.error(`Package not found in workspace: ${args.name}`);
        process.exit(1);
      }
      targets = [pkg.name];
    } else {
      targets = workspace.packages.map((p) => p.name);
    }

    let publishSet;
    if (args.fast) {
      publishSet = targets
        .map((name) => findPackage(workspace.packages, name))
        .filter(Boolean) as typeof workspace.packages;
    } else {
      publishSet = computeCascade(graph, targets);
    }

    const version = generateVersion();
    const plan = buildPublishPlan(publishSet, version);

    if (args["dry-run"]) {
      log.info("Dry run - would publish:");
      for (const entry of plan.packages) {
        log.line(`  ${entry.name}@${entry.version}`);
        for (const [dep, ver] of Object.entries(entry.rewrittenDeps)) {
          log.dim(`    ${dep} -> ${ver}`);
        }
      }
      return;
    }

    const releaseLock = await acquirePublishLock();
    try {
      await executePublish(plan, config);

      log.success(`Published ${plan.packages.length} packages:`);
      for (const entry of plan.packages) {
        log.line(`  ${entry.name}@${entry.version}`);
      }
    } finally {
      await releaseLock();
    }
  },
});
```

**Step 2: Verify publishing**

Run: `pkglab start`

Run: `cd /path/to/a/monorepo && pkglab pub --dry-run`
Expected: list of packages that would be published with cascade

Run: `pkglab pub @scope/pkg`
Expected: packages published successfully

Run: `curl -s http://localhost:4873/@scope/pkg | python3 -m json.tool | grep version`
Expected: shows "0.0.0-pkglab.XXXX"

**Step 3: Commit**

```bash
git add src/commands/pub.ts
git commit -m "feat: pub command with cascade, dry-run, and rollback"
```

---

## Task 8: consumer core (add/rm commands)

**Files:**

- Create: `src/lib/pm-detect.ts`
- Create: `src/lib/repo-state.ts`
- Create: `src/lib/consumer.ts`
- Modify: `src/commands/add.ts`
- Modify: `src/commands/rm.ts`

**Step 1: Create src/lib/pm-detect.ts**

```typescript
import { join } from "node:path";
import { PackageManagerAmbiguousError } from "./errors";

export type PackageManager = "npm" | "pnpm" | "bun";

const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "package-lock.json": "npm",
};

export async function detectPackageManager(
  repoPath: string,
): Promise<PackageManager> {
  const found: PackageManager[] = [];

  for (const [lockfile, pm] of Object.entries(LOCKFILES)) {
    const file = Bun.file(join(repoPath, lockfile));
    if (await file.exists()) {
      if (!found.includes(pm)) found.push(pm);
    }
  }

  if (found.length === 0) return "npm";
  if (found.length > 1) {
    throw new PackageManagerAmbiguousError(
      `Multiple PMs detected: ${found.join(", ")}. Remove extra lockfiles.`,
    );
  }
  return found[0];
}

export function installCommand(
  pm: PackageManager,
  pkg: string,
  version: string,
): string[] {
  const spec = `${pkg}@${version}`;
  switch (pm) {
    case "npm":
      return ["npm", "install", spec];
    case "pnpm":
      return ["pnpm", "add", spec];
    case "bun":
      return ["bun", "add", spec];
  }
}
```

**Step 2: Create src/lib/repo-state.ts**

```typescript
import { join, basename } from "node:path";
import { realpath, readdir } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { paths } from "./paths";
import type { RepoState } from "../types";

export async function canonicalRepoPath(dir: string): Promise<string> {
  return realpath(dir);
}

async function deriveRepoName(repoPath: string): Promise<string> {
  const pkgFile = Bun.file(join(repoPath, "package.json"));
  if (await pkgFile.exists()) {
    try {
      const pkg = await pkgFile.json();
      if (pkg.name) return pkg.name.replace("/", "-").replace("@", "");
    } catch {}
  }
  return basename(repoPath);
}

export async function repoFileName(repoPath: string): Promise<string> {
  const all = await loadAllRepos();

  // Check if this path is already registered
  for (const [filename, state] of Object.entries(all)) {
    if (state.path === repoPath) return filename;
  }

  const name = await deriveRepoName(repoPath);
  let candidate = name;
  let suffix = 2;
  while (all[candidate]) {
    candidate = `${name}~${suffix}`;
    suffix++;
  }
  return candidate;
}

export async function loadRepoState(name: string): Promise<RepoState | null> {
  const file = Bun.file(join(paths.reposDir, `${name}.yaml`));
  if (!(await file.exists())) return null;
  const text = await file.text();
  return parse(text) as RepoState;
}

export async function saveRepoState(
  name: string,
  state: RepoState,
): Promise<void> {
  const filePath = join(paths.reposDir, `${name}.yaml`);
  await Bun.write(filePath, stringify(state));
}

export async function loadAllRepos(): Promise<Record<string, RepoState>> {
  const result: Record<string, RepoState> = {};
  try {
    const files = await readdir(paths.reposDir);
    for (const file of files) {
      if (!file.endsWith(".yaml")) continue;
      const name = file.replace(".yaml", "");
      const state = await loadRepoState(name);
      if (state) result[name] = state;
    }
  } catch {}
  return result;
}

export async function findRepoByPath(
  repoPath: string,
): Promise<{ name: string; state: RepoState } | null> {
  const canonical = await canonicalRepoPath(repoPath);
  const all = await loadAllRepos();
  for (const [name, state] of Object.entries(all)) {
    if (state.path === canonical) return { name, state };
  }
  return null;
}

export async function getActiveRepos(): Promise<
  Array<{ name: string; state: RepoState }>
> {
  const all = await loadAllRepos();
  return Object.entries(all)
    .filter(([_, state]) => state.active)
    .map(([name, state]) => ({ name, state }));
}

export async function deactivateAllRepos(): Promise<void> {
  const all = await loadAllRepos();
  for (const [name, state] of Object.entries(all)) {
    if (state.active) {
      state.active = false;
      await saveRepoState(name, state);
    }
  }
}
```

**Step 3: Create src/lib/consumer.ts**

```typescript
import { join } from "node:path";
import { log } from "./log";
import { NpmrcConflictError } from "./errors";
import { detectPackageManager, installCommand } from "./pm-detect";
import type { PackageManager } from "./pm-detect";

const MARKER_START = "# pkglab-start";
const MARKER_END = "# pkglab-end";

export async function addRegistryToNpmrc(
  repoPath: string,
  port: number,
): Promise<{ isFirstTime: boolean }> {
  const npmrcPath = join(repoPath, ".npmrc");
  const file = Bun.file(npmrcPath);
  let content = "";
  let isFirstTime = true;

  if (await file.exists()) {
    content = await file.text();

    if (content.includes(MARKER_START)) {
      isFirstTime = false;
      content = removepkglabBlock(content);
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("registry=") &&
        !trimmed.includes("localhost") &&
        !trimmed.includes("127.0.0.1")
      ) {
        throw new NpmrcConflictError(
          `Existing registry in .npmrc: ${trimmed}\npkglab cannot override this.`,
        );
      }
    }
  }

  const block = `${MARKER_START}\nregistry=http://127.0.0.1:${port}\n${MARKER_END}`;
  content = content.trimEnd() + "\n" + block + "\n";
  await Bun.write(npmrcPath, content);

  return { isFirstTime };
}

export async function removeRegistryFromNpmrc(repoPath: string): Promise<void> {
  const npmrcPath = join(repoPath, ".npmrc");
  const file = Bun.file(npmrcPath);
  if (!(await file.exists())) return;

  let content = await file.text();
  content = removepkglabBlock(content);
  await Bun.write(npmrcPath, content);
}

function removepkglabBlock(content: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return content;

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + MARKER_END.length);
  return (before + after).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export async function applySkipWorktree(repoPath: string): Promise<void> {
  const proc = Bun.spawn(["git", "update-index", "--skip-worktree", ".npmrc"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

export async function removeSkipWorktree(repoPath: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "update-index", "--no-skip-worktree", ".npmrc"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

export async function isSkipWorktreeSet(repoPath: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "ls-files", "-v", ".npmrc"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  return output.startsWith("S ");
}

export async function scopedInstall(
  repoPath: string,
  pkgName: string,
  version: string,
  pm?: PackageManager,
): Promise<void> {
  const detectedPm = pm || (await detectPackageManager(repoPath));
  const cmd = installCommand(detectedPm, pkgName, version);

  log.dim(`  ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Install failed: ${stderr}`);
  }
}

export async function updatePackageJsonVersion(
  repoPath: string,
  pkgName: string,
  version: string,
): Promise<{ previousVersion: string }> {
  const pkgJsonPath = join(repoPath, "package.json");
  const pkgJson = await Bun.file(pkgJsonPath).json();

  let previousVersion = "";
  for (const field of ["dependencies", "devDependencies"]) {
    if (pkgJson[field]?.[pkgName]) {
      previousVersion = pkgJson[field][pkgName];
      pkgJson[field][pkgName] = version;
    }
  }

  await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  return { previousVersion };
}
```

**Step 4: Implement src/commands/add.ts**

```typescript
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
import { ispkglabVersion, extractTimestamp } from "../lib/version";
import { log } from "../lib/log";
import { DaemonNotRunningError } from "../lib/errors";
import type { RepoState } from "../types";

export default defineCommand({
  meta: { name: "add", description: "Add a pkglab package to this repo" },
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
    const pkglabVersions = versions
      .filter(ispkglabVersion)
      .sort((a, b) => extractTimestamp(b) - extractTimestamp(a));

    if (pkglabVersions.length === 0) {
      log.error(
        `No pkglab versions for ${pkgName}. Publish first: pkglab pub ${pkgName}`,
      );
      process.exit(1);
    }

    const latestVersion = pkglabVersions[0];

    const { isFirstTime } = await addRegistryToNpmrc(repoPath, config.port);
    if (isFirstTime) {
      await applySkipWorktree(repoPath);
      log.info(
        "notice: pkglab added registry entries to .npmrc\n" +
          "These entries point to localhost and will break CI if committed.\n" +
          "pkglab has applied --skip-worktree to prevent accidental commits.\n" +
          "Run pkglab rm to restore your .npmrc.",
      );
    }

    const { previousVersion } = await updatePackageJsonVersion(
      repoPath,
      pkgName,
      latestVersion,
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
```

**Step 5: Implement src/commands/rm.ts**

```typescript
import { defineCommand } from "citty";
import {
  removeRegistryFromNpmrc,
  removeSkipWorktree,
  updatePackageJsonVersion,
} from "../lib/consumer";
import {
  canonicalRepoPath,
  findRepoByPath,
  saveRepoState,
} from "../lib/repo-state";
import { log } from "../lib/log";

export default defineCommand({
  meta: {
    name: "rm",
    description: "Remove a pkglab package, restore original",
  },
  args: {
    name: { type: "positional", description: "Package name", required: true },
  },
  async run({ args }) {
    const repoPath = await canonicalRepoPath(process.cwd());
    const pkgName = args.name as string;

    const repo = await findRepoByPath(repoPath);
    if (!repo || !repo.state.packages[pkgName]) {
      log.warn(`${pkgName} is not linked via pkglab in this repo`);
      return;
    }

    const original = repo.state.packages[pkgName].original;

    if (original) {
      await updatePackageJsonVersion(repoPath, pkgName, original);
      log.info(`Restored ${pkgName} to ${original}`);
    }

    delete repo.state.packages[pkgName];
    await saveRepoState(repo.name, repo.state);

    if (Object.keys(repo.state.packages).length === 0) {
      await removeRegistryFromNpmrc(repoPath);
      await removeSkipWorktree(repoPath);
      log.info("All pkglab packages removed, .npmrc restored");
    }

    log.success(`Removed ${pkgName} from pkglab`);
  },
});
```

**Step 6: Commit**

```bash
git add src/lib/pm-detect.ts src/lib/repo-state.ts src/lib/consumer.ts src/commands/add.ts src/commands/rm.ts
git commit -m "feat: consumer core (add/rm with .npmrc, skip-worktree, scoped installs)"
```

---

## Task 9: repo management commands

**Files:**

- Modify: `src/commands/repos/ls.ts`
- Modify: `src/commands/repos/activate.ts`
- Modify: `src/commands/repos/deactivate.ts`
- Modify: `src/commands/repos/reset.ts`
- Modify: `src/commands/repos/rename.ts`
- Modify: `src/commands/pub.ts` (add auto-update of active repos)
- Modify: `src/commands/start.ts` (add deactivate-all + repo listing)

**Step 1: Implement repos/ls.ts**

```typescript
import { defineCommand } from "citty";
import { loadAllRepos } from "../../lib/repo-state";
import { log } from "../../lib/log";
import pc from "picocolors";

export default defineCommand({
  meta: { name: "ls", description: "List linked consumer repos" },
  async run() {
    const repos = await loadAllRepos();
    const entries = Object.entries(repos);

    if (entries.length === 0) {
      log.info("No linked repos. Use pkglab add in a consumer repo.");
      return;
    }

    for (const [name, state] of entries) {
      const status = state.active ? pc.green("active") : pc.dim("inactive");
      const pkgCount = Object.keys(state.packages).length;
      log.line(
        `  ${name.padEnd(20)} ${status.padEnd(18)} ` +
          `${pkgCount} pkg${pkgCount !== 1 ? "s" : ""}  ${pc.dim(state.path)}`,
      );
    }
  },
});
```

**Step 2: Implement repos/activate.ts**

```typescript
import { defineCommand } from "citty";
import { loadRepoState, saveRepoState } from "../../lib/repo-state";
import { addRegistryToNpmrc, applySkipWorktree } from "../../lib/consumer";
import { loadConfig } from "../../lib/config";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "activate", description: "Activate repo for auto-updates" },
  args: {
    name: { type: "positional", description: "Repo name", required: true },
  },
  async run({ args }) {
    const name = args.name as string;
    const state = await loadRepoState(name);
    if (!state) {
      log.error(`Repo not found: ${name}`);
      process.exit(1);
    }

    const config = await loadConfig();
    await addRegistryToNpmrc(state.path, config.port);
    await applySkipWorktree(state.path);

    state.active = true;
    await saveRepoState(name, state);
    log.success(`Activated ${name}`);
  },
});
```

**Step 3: Implement repos/deactivate.ts**

```typescript
import { defineCommand } from "citty";
import { loadRepoState, saveRepoState } from "../../lib/repo-state";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "deactivate", description: "Deactivate repo" },
  args: {
    name: { type: "positional", description: "Repo name", required: true },
  },
  async run({ args }) {
    const name = args.name as string;
    const state = await loadRepoState(name);
    if (!state) {
      log.error(`Repo not found: ${name}`);
      process.exit(1);
    }

    state.active = false;
    await saveRepoState(name, state);
    log.success(`Deactivated ${name}`);
  },
});
```

**Step 4: Implement repos/reset.ts**

```typescript
import { defineCommand } from "citty";
import {
  loadRepoState,
  saveRepoState,
  loadAllRepos,
} from "../../lib/repo-state";
import {
  removeRegistryFromNpmrc,
  removeSkipWorktree,
  updatePackageJsonVersion,
} from "../../lib/consumer";
import { log } from "../../lib/log";
import type { RepoState } from "../../types";

export default defineCommand({
  meta: { name: "reset", description: "Reset repo to original versions" },
  args: {
    name: { type: "positional", description: "Repo name", required: false },
    all: { type: "boolean", description: "Reset all repos", default: false },
  },
  async run({ args }) {
    let targets: Array<[string, RepoState]>;

    if (args.all) {
      targets = Object.entries(await loadAllRepos());
    } else if (args.name) {
      const state = await loadRepoState(args.name as string);
      if (!state) {
        log.error(`Repo not found: ${args.name}`);
        process.exit(1);
      }
      targets = [[args.name as string, state]];
    } else {
      log.error("Specify a repo name or --all");
      process.exit(1);
    }

    for (const [name, state] of targets) {
      log.info(`Resetting ${name}...`);
      for (const [pkgName, link] of Object.entries(state.packages)) {
        if (link.original) {
          await updatePackageJsonVersion(state.path, pkgName, link.original);
          log.dim(`  ${pkgName} -> ${link.original}`);
        }
      }

      await removeRegistryFromNpmrc(state.path);
      await removeSkipWorktree(state.path);
      state.packages = {};
      state.active = false;
      await saveRepoState(name, state);
      log.success(`Reset ${name}`);
    }
  },
});
```

**Step 5: Implement repos/rename.ts**

```typescript
import { defineCommand } from "citty";
import { loadRepoState } from "../../lib/repo-state";
import { paths } from "../../lib/paths";
import { join } from "node:path";
import { rename } from "node:fs/promises";
import { log } from "../../lib/log";

export default defineCommand({
  meta: { name: "rename", description: "Rename a repo alias" },
  args: {
    old: { type: "positional", description: "Current name", required: true },
    new_name: { type: "positional", description: "New name", required: true },
  },
  async run({ args }) {
    const oldName = args.old as string;
    const newName = args.new_name as string;

    const state = await loadRepoState(oldName);
    if (!state) {
      log.error(`Repo not found: ${oldName}`);
      process.exit(1);
    }

    await rename(
      join(paths.reposDir, `${oldName}.yaml`),
      join(paths.reposDir, `${newName}.yaml`),
    );
    log.success(`Renamed ${oldName} -> ${newName}`);
  },
});
```

**Step 6: Add auto-update to pub.ts**

After the existing publish success output in `src/commands/pub.ts`, add:

```typescript
// Auto-update active consumer repos
const { getActiveRepos, saveRepoState: saveRepo } =
  await import("../lib/repo-state");
const { detectPackageManager } = await import("../lib/pm-detect");
const { updatePackageJsonVersion, scopedInstall } =
  await import("../lib/consumer");

const activeRepos = await getActiveRepos();
if (activeRepos.length > 0) {
  log.info("\nUpdating active repos:");
  for (const { name, state } of activeRepos) {
    const pm = await detectPackageManager(state.path);
    const updated: string[] = [];

    for (const entry of plan.packages) {
      if (state.packages[entry.name]) {
        await updatePackageJsonVersion(state.path, entry.name, entry.version);
        await scopedInstall(state.path, entry.name, entry.version, pm);
        state.packages[entry.name].current = entry.version;
        updated.push(entry.name);
      }
    }

    if (updated.length > 0) {
      await saveRepo(name, state);
      log.success(`  ${name}: updated ${updated.join(", ")}`);
    }
  }
}
```

**Step 7: Add deactivate-all and repo listing to start.ts**

After daemon start in `src/commands/start.ts`, add:

```typescript
const { deactivateAllRepos, loadAllRepos } = await import("../lib/repo-state");
await deactivateAllRepos();

const repos = await loadAllRepos();
const entries = Object.entries(repos);
if (entries.length > 0) {
  log.info("\nLinked repos (all inactive):");
  for (const [name, state] of entries) {
    log.line(`  ${name.padEnd(20)} ${state.path}`);
  }
  log.dim("\nActivate repos: pkglab repos activate <name>");
}
```

**Step 8: Commit**

```bash
git add src/commands/repos/ src/commands/pub.ts src/commands/start.ts
git commit -m "feat: repo management (ls/activate/deactivate/reset/rename) + auto-update on pub"
```

---

## Task 10: operational commands (prune, pkgs ls, doctor, check)

**Files:**

- Create: `src/lib/prune.ts`
- Modify: `src/commands/prune.ts`
- Modify: `src/commands/pkgs/ls.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/commands/check.ts`
- Modify: `src/commands/pub.ts` (add auto-prune)

**Step 1: Create src/lib/prune.ts**

```typescript
import type { pkglabConfig } from "../types";
import {
  getPackageVersions,
  listAllPackages,
  unpublishVersion,
} from "./registry";
import { getActiveRepos } from "./repo-state";
import { ispkglabVersion, extractTimestamp } from "./version";
import { log } from "./log";

export async function prunePackage(
  config: pkglabConfig,
  pkgName: string,
): Promise<number> {
  const versions = await getPackageVersions(config, pkgName);
  const pkglabVersions = versions
    .filter(ispkglabVersion)
    .sort((a, b) => extractTimestamp(b) - extractTimestamp(a));

  if (pkglabVersions.length <= config.prune_keep) return 0;

  const activeRepos = await getActiveRepos();
  const referenced = new Set<string>();
  for (const { state } of activeRepos) {
    for (const link of Object.values(state.packages)) {
      referenced.add(link.current);
    }
  }

  const toRemove = pkglabVersions
    .slice(config.prune_keep)
    .filter((v) => !referenced.has(v));

  for (const version of toRemove) {
    await unpublishVersion(config, pkgName, version);
    log.dim(`  Pruned ${pkgName}@${version}`);
  }

  return toRemove.length;
}

export async function pruneAll(config: pkglabConfig): Promise<number> {
  const packages = await listAllPackages(config);
  let total = 0;
  for (const pkg of packages) {
    const pkglabVersions = pkg.versions.filter(ispkglabVersion);
    if (pkglabVersions.length > 0) {
      total += await prunePackage(config, pkg.name);
    }
  }
  return total;
}
```

**Step 2: Implement prune, pkgs ls, doctor, check commands**

These follow the same pattern as earlier commands. See the agent plan research output for full implementations of each. Key points:

- `prune.ts`: verify daemon running, call pruneAll, report count
- `pkgs/ls.ts`: fetch from Verdaccio API, show latest pkglab version per package
- `doctor.ts`: run checks (Bun version, pkglab dirs, daemon, registry ping, skip-worktree state), auto-fix broken skip-worktree
- `check.ts`: scan package.json for pkglab versions, scan .npmrc for markers, scan git staged files, exit 1 if issues

**Step 3: Add auto-prune to pub.ts**

After consumer auto-update section:

```typescript
try {
  const { pruneAll } = await import("../lib/prune");
  const pruned = await pruneAll(config);
  if (pruned > 0) log.dim(`Pruned ${pruned} old versions`);
} catch {
  // Non-fatal
}
```

**Step 4: Commit**

```bash
git add src/lib/prune.ts src/commands/prune.ts src/commands/pkgs/ls.ts src/commands/doctor.ts src/commands/check.ts src/commands/pub.ts
git commit -m "feat: operational commands (prune, pkgs ls, doctor, check)"
```

---

## Task 11: end-to-end verification

**Step 1: Full flow test**

```bash
# Start daemon
pkglab start

# In a monorepo publisher:
cd /path/to/monorepo
pkglab pub --dry-run
pkglab pub @scope/pkg

# In a consumer repo:
cd /path/to/consumer
pkglab add @scope/pkg
# Verify: package.json has 0.0.0-pkglab.* version
# Verify: .npmrc has pkglab markers
# Verify: node_modules/@scope/pkg exists

# Activate for auto-updates
pkglab repos activate consumer-name

# Re-publish from publisher
cd /path/to/monorepo
pkglab pub @scope/pkg
# Verify: consumer auto-updated

# Check commands
pkglab status
pkglab repos ls
pkglab pkgs ls
pkglab doctor
pkglab logs

# Cleanup
cd /path/to/consumer
pkglab rm @scope/pkg
# Verify: original version restored

pkglab repos reset --all
pkglab stop
```

**Step 2: Create .gitignore and commit**

```bash
echo "node_modules/\ndist/" > .gitignore
git add .gitignore
git commit -m "chore: add gitignore"
```
