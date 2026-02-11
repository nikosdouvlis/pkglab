import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "pkg", description: "Manage packages in Verdaccio" },
  subCommands: {
    ls: () => import("./ls").then((m) => m.default),
  },
});
