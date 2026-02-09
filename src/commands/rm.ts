import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "rm", description: "Remove a pkgl package, restore original" },
  args: {
    name: { type: "positional", description: "Package name", required: true },
  },
  run() {
    console.log("pkgl rm: not implemented yet");
  },
});
