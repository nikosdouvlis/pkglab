#!/usr/bin/env bun

import { runServer } from "verdaccio";
import { buildVerdaccioConfig } from "./verdaccio-config";
import { loadConfig, ensurepkglabDirs } from "./config";
import { mkdir } from "node:fs/promises";
import { paths } from "./paths";

async function main() {
  await ensurepkglabDirs();
  await mkdir(paths.verdaccioStorage, { recursive: true });

  const config = await loadConfig();
  const verdaccioConfig = buildVerdaccioConfig();

  const app = await runServer(verdaccioConfig);

  app.listen(config.port, "127.0.0.1", () => {
    process.stdout.write("READY\n");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
