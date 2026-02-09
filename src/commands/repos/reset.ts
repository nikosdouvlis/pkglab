import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "reset", description: "Reset repo to original versions" },
  args: {
    name: { type: "positional", description: "Repo name", required: false },
    all: { type: "boolean", description: "Reset all repos", default: false },
  },
  run() {
    console.log("pkgl repos reset: not implemented yet");
  },
});
