import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "stop", description: "Stop Verdaccio daemon" },
  run() {
    console.log("pkgl stop: not implemented yet");
  },
});
