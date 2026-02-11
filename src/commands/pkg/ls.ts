import { defineCommand } from "citty";
import { listAllPackages } from "../../lib/registry";
import { extractTag, extractTimestamp } from "../../lib/version";
import { log } from "../../lib/log";
import { c } from "../../lib/color";

export default defineCommand({
  meta: { name: "ls", description: "List packages in Verdaccio" },
  async run() {
    const pkglabPackages = await listAllPackages();

    if (pkglabPackages.length === 0) {
      log.info("No packages published to Verdaccio");
      return;
    }

    for (const pkg of pkglabPackages) {
      // Group versions by tag
      const tagMap = new Map<string, string[]>();
      for (const v of pkg.versions) {
        const tag = extractTag(v) ?? "(untagged)";
        const existing = tagMap.get(tag);
        if (existing) {
          existing.push(v);
        } else {
          tagMap.set(tag, [v]);
        }
      }

      log.line(`  ${pkg.name}`);

      // Sort tags: (untagged) first, then alphabetical
      const tags = [...tagMap.keys()].sort((a, b) => {
        if (a === "(untagged)") return -1;
        if (b === "(untagged)") return 1;
        return a.localeCompare(b);
      });

      for (const tag of tags) {
        const versions = tagMap.get(tag)!;
        // Pick the latest version by timestamp
        const latest = versions.reduce((best, v) => {
          const ts = extractTimestamp(v);
          const bestTs = extractTimestamp(best);
          return ts > bestTs ? v : best;
        });
        const label = tag.padEnd(20);
        log.line(`    ${c.dim(label)} ${c.green(latest)}`);
      }
    }
  },
});
