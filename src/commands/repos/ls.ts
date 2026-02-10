import { defineCommand } from "citty";
import { loadAllRepos } from "../../lib/repo-state";
import { log } from "../../lib/log";
import { c } from "../../lib/color";

export default defineCommand({
  meta: { name: "ls", description: "List linked consumer repos" },
  async run() {
    const repos = await loadAllRepos();
    const entries = Object.entries(repos);

    if (entries.length === 0) {
      log.info("No linked repos. Use pkglab add in a consumer repo.");
      return;
    }

    for (const [name, state] of entries) {
      const status = state.active ? c.green("active") : c.dim("inactive");
      const pkgCount = Object.keys(state.packages).length;
      log.line(
        `  ${name.padEnd(20)} ${status.padEnd(18)} ` +
          `${pkgCount} pkg${pkgCount !== 1 ? "s" : ""}  ${c.dim(state.path)}`,
      );
    }
  },
});
