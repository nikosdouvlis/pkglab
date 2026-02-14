#!/usr/bin/env bun

// Hidden flag: when the daemon spawns itself as a worker, run verdaccio directly
if (process.argv.includes("--__worker")) {
  const { main } = await import("./lib/verdaccio-worker");
  await main();
  // Keep process alive (verdaccio server is listening)
  await new Promise(() => {});
}

// Hidden flag: detached prune subprocess
if (process.argv.includes("--__prune")) {
  const { pruneAll } = await import("./lib/prune");
  const idx = process.argv.indexOf("--__prune");
  const port = Number(process.argv[idx + 1]);
  const pruneKeep = Number(process.argv[idx + 2]);
  const tag = process.argv[idx + 3];
  await pruneAll({ port, prune_keep: pruneKeep }, tag || undefined).catch(() => {});
  process.exit(0);
}

import { defineCommand, runMain } from "citty";
import { ensurepkglabDirs } from "./lib/config";
import { getVersion } from "./lib/version";

const pkgVersion = await getVersion();

if (process.argv[2] === "version") {
  process.argv[2] = "--version";
}

const cmd = defineCommand({
  meta: {
    name: "pkglab",
    version: pkgVersion,
    description: "Local package development with Verdaccio",
  },
  subCommands: {
    up: () => import("./commands/up").then((m) => m.default),
    down: () => import("./commands/down").then((m) => m.default),
    status: () => import("./commands/status").then((m) => m.default),
    logs: () => import("./commands/logs").then((m) => m.default),
    pub: () => import("./commands/pub").then((m) => m.default),
    add: () => import("./commands/add").then((m) => m.default),
    restore: () => import("./commands/restore").then((m) => m.default),
    repo: () => import("./commands/repo/index").then((m) => m.default),
    pkg: () => import("./commands/pkg/index").then((m) => m.default),
    reset: () => import("./commands/reset").then((m) => m.default),
    doctor: () => import("./commands/doctor").then((m) => m.default),
    check: () => import("./commands/check").then((m) => m.default),
    listen: () => import("./commands/listen").then((m) => m.default),
  },
  async setup() {
    await ensurepkglabDirs();
  },
});

runMain(cmd);
