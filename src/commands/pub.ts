import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "pub", description: "Publish packages to local Verdaccio" },
  args: {
    name: { type: "positional", description: "Package name", required: false },
    "dry-run": { type: "boolean", description: "Show what would be published", default: false },
    fast: { type: "boolean", description: "Skip dep cascade", default: false },
  },
  run() {
    console.log("pkgl pub: not implemented yet");
  },
});
