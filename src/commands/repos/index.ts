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
