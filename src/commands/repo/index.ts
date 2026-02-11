import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "repo", description: "Manage linked consumer repos" },
  subCommands: {
    ls: () => import("./ls").then((m) => m.default),
    on: () => import("./activate").then((m) => m.default),
    off: () => import("./deactivate").then((m) => m.default),
    reset: () => import("./reset").then((m) => m.default),
    rename: () => import("./rename").then((m) => m.default),
  },
});
