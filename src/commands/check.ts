import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "check", description: "Pre-commit safety check for pkgl artifacts" },
  run() {
    console.log("pkgl check: not implemented yet");
  },
});
