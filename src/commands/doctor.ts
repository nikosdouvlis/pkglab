import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "doctor", description: "Health check for pkgl environment" },
  run() {
    console.log("pkgl doctor: not implemented yet");
  },
});
