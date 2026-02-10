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

runMain(main);
