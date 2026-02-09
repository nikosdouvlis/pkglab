import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "add", description: "Add a pkgl package to this repo" },
  args: {
    name: { type: "positional", description: "Package name", required: true },
  },
  run() {
    console.log("pkgl add: not implemented yet");
  },
});
