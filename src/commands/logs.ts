import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "logs", description: "Tail Verdaccio logs" },
  args: {
    follow: { type: "boolean", alias: "f", description: "Stream logs", default: false },
  },
  run() {
    console.log("pkgl logs: not implemented yet");
  },
});
