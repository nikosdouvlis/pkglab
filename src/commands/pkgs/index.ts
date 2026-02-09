import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "pkgs", description: "Manage packages in Verdaccio" },
  subCommands: {
    ls: () => import("./ls").then((m) => m.default),
  },
});
