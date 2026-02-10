#!/usr/bin/env bun

// Hidden flag: when the daemon spawns itself as a worker, run verdaccio directly
if (process.argv.includes("--__worker")) {
  const { main } = await import("./lib/verdaccio-worker");
  await main();
  // Keep process alive (verdaccio server is listening)
  await new Promise(() => {});
}

import { join } from "node:path";
import { defineCommand, runMain } from "citty";
import { ensurepkglabDirs } from "./lib/config";

declare const __PKGLAB_VERSION__: string | undefined;

let pkgVersion: string;
try {
  const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json();
  pkgVersion = pkg.version;
} catch {
  pkgVersion = typeof __PKGLAB_VERSION__ !== "undefined" ? __PKGLAB_VERSION__ : "0.0.0";
}

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
    up: () => import("./commands/start").then((m) => m.default),
    down: () => import("./commands/stop").then((m) => m.default),
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

runMain(cmd);
