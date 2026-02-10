import { defineCommand } from "citty";
import { join } from "node:path";

export default defineCommand({
  meta: { name: "version", description: "Show pkglab version" },
  async run() {
    const pkgPath = join(import.meta.dir, "../../package.json");
    const pkg = await Bun.file(pkgPath).json();
    console.log(pkg.version);
  },
});
