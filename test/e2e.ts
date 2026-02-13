import { resolve, join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

const projectRoot = resolve(import.meta.dir, "..");
const ENTRY = resolve(projectRoot, "src/index.ts");

// ── Helpers ──

let passed = 0;
let failed = 0;

async function pkglab(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    cwd: opts?.cwd ?? projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function readPkgJson(dir: string): Promise<Record<string, any>> {
  return Bun.file(join(dir, "package.json")).json();
}

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.log(`  FAIL: ${msg}`);
    failed++;
    throw new Error(msg);
  }
  console.log(`  pass: ${msg}`);
  passed++;
}

function heading(msg: string): void {
  console.log(`\n── ${msg} ──`);
}

async function writeJson(path: string, data: Record<string, any>): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

function getDep(pkgJson: Record<string, any>, name: string): string | undefined {
  return pkgJson.dependencies?.[name] ?? pkgJson.devDependencies?.[name];
}

// ── Setup ──

const testDir = join("/tmp", `pkglab-test-${Date.now()}`);
const producerDir = join(testDir, "producer");
const consumer1Dir = join(testDir, "consumer-1");
const consumer2Dir = join(testDir, "consumer-2");

heading("Setup");
console.log(`  Test dir: ${testDir}`);

// Create directory structure
await mkdir(join(producerDir, "packages/pkg-a"), { recursive: true });
await mkdir(join(producerDir, "packages/pkg-b"), { recursive: true });
await mkdir(join(producerDir, "packages/pkg-c"), { recursive: true });
await mkdir(consumer1Dir, { recursive: true });
await mkdir(consumer2Dir, { recursive: true });

// Producer: workspace root
await writeJson(join(producerDir, "package.json"), {
  name: "test-producer",
  private: true,
  workspaces: ["packages/*"],
});

// Producer: pkg-a
await writeJson(join(producerDir, "packages/pkg-a/package.json"), {
  name: "@test/pkg-a",
  version: "1.0.0",
});

// Producer: pkg-b (depends on pkg-a)
await writeJson(join(producerDir, "packages/pkg-b/package.json"), {
  name: "@test/pkg-b",
  version: "1.0.0",
  dependencies: { "@test/pkg-a": "workspace:*" },
});

// Producer: pkg-c (depends on pkg-a, used to test consumer-aware filtering)
await writeJson(join(producerDir, "packages/pkg-c/package.json"), {
  name: "@test/pkg-c",
  version: "1.0.0",
  dependencies: { "@test/pkg-a": "workspace:*" },
});

// Consumers: minimal package.json + bun install for lockfile
for (const [dir, name] of [
  [consumer1Dir, "consumer-1"],
  [consumer2Dir, "consumer-2"],
] as const) {
  await writeJson(join(dir, "package.json"), {
    name,
    version: "1.0.0",
    dependencies: {},
  });
  // Create bun lockfile so PM detection picks up bun
  const proc = Bun.spawn(["bun", "install"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

// Install producer workspace
const prodInstall = Bun.spawn(["bun", "install"], {
  cwd: producerDir,
  stdout: "ignore",
  stderr: "ignore",
});
await prodInstall.exited;

// ── Tests ──

try {
  // 1. Start registry
  heading("1. pkglab up");
  {
    const r = await pkglab(["up"]);
    assert(r.code === 0, "pkglab up succeeds");
  }

  // Give Verdaccio a moment to be ready
  await Bun.sleep(1000);

  // 2. Publish untagged from producer
  heading("2. pkglab pub (untagged)");
  {
    const r = await pkglab(["pub"], { cwd: producerDir });
    assert(r.code === 0, "pkglab pub succeeds");
  }

  // 3. Add @test/pkg-a to consumer-1 (untagged)
  heading("3. pkglab add @test/pkg-a (consumer-1, untagged)");
  {
    const r = await pkglab(["add", "@test/pkg-a"], { cwd: consumer1Dir });
    assert(r.code === 0, "pkglab add succeeds");

    const pkg = await readPkgJson(consumer1Dir);
    const ver = getDep(pkg, "@test/pkg-a");
    assert(!!ver, "consumer-1 has @test/pkg-a in deps");
    assert(ver!.includes("0.0.0-pkglab."), "version is untagged pkglab format");
  }

  // 4. Publish tagged (feat1) from producer
  heading("4. pkglab pub -t feat1");
  {
    const r = await pkglab(["pub", "-t", "feat1"], { cwd: producerDir });
    assert(r.code === 0, "pkglab pub -t feat1 succeeds");
  }

  // 5. Add @test/pkg-a@feat1 to consumer-2
  heading("5. pkglab add @test/pkg-a@feat1 (consumer-2)");
  {
    const r = await pkglab(["add", "@test/pkg-a@feat1"], { cwd: consumer2Dir });
    assert(r.code === 0, "pkglab add @test/pkg-a@feat1 succeeds");

    const pkg = await readPkgJson(consumer2Dir);
    const ver = getDep(pkg, "@test/pkg-a");
    assert(!!ver, "consumer-2 has @test/pkg-a in deps");
    assert(
      ver!.includes("0.0.0-pkglab-feat1."),
      "version is tagged pkglab-feat1 format",
    );
  }

  // 6. Publish untagged again, verify consumer-1 updated but consumer-2 NOT
  heading("6. Tag isolation: untagged pub");
  {
    // Record current versions
    const c1Before = getDep(await readPkgJson(consumer1Dir), "@test/pkg-a")!;
    const c2Before = getDep(await readPkgJson(consumer2Dir), "@test/pkg-a")!;

    // Touch a file so fingerprinting detects a change
    await Bun.write(join(producerDir, "packages/pkg-a/index.js"), "// updated for test 6\n");

    const r = await pkglab(["pub"], { cwd: producerDir });
    assert(r.code === 0, "pkglab pub (untagged) succeeds");

    const c1After = getDep(await readPkgJson(consumer1Dir), "@test/pkg-a")!;
    const c2After = getDep(await readPkgJson(consumer2Dir), "@test/pkg-a")!;

    assert(c1After !== c1Before, "consumer-1 (untagged) got updated");
    assert(c2After === c2Before, "consumer-2 (feat1) was NOT updated");
    assert(c1After.includes("0.0.0-pkglab."), "consumer-1 still has untagged version");
  }

  // 7. Publish tagged (feat1) again, verify consumer-2 updated but consumer-1 NOT
  heading("7. Tag isolation: tagged pub");
  {
    const c1Before = getDep(await readPkgJson(consumer1Dir), "@test/pkg-a")!;
    const c2Before = getDep(await readPkgJson(consumer2Dir), "@test/pkg-a")!;

    // Touch a file so fingerprinting detects a change
    await Bun.write(join(producerDir, "packages/pkg-a/index.js"), "// updated for test 7\n");

    const r = await pkglab(["pub", "-t", "feat1"], { cwd: producerDir });
    assert(r.code === 0, "pkglab pub -t feat1 succeeds");

    const c1After = getDep(await readPkgJson(consumer1Dir), "@test/pkg-a")!;
    const c2After = getDep(await readPkgJson(consumer2Dir), "@test/pkg-a")!;

    assert(c1After === c1Before, "consumer-1 (untagged) was NOT updated");
    assert(c2After !== c2Before, "consumer-2 (feat1) got updated");
    assert(c2After.includes("0.0.0-pkglab-feat1."), "consumer-2 still has feat1 tag");
  }

  // 8. pkg ls shows both tagged and untagged
  heading("8. pkglab pkg ls");
  {
    const r = await pkglab(["pkg", "ls"]);
    assert(r.code === 0, "pkglab pkg ls succeeds");

    const out = r.stdout;
    assert(out.includes("@test/pkg-a"), "output contains @test/pkg-a");
    assert(out.includes("(untagged)"), "output shows untagged versions");
    assert(out.includes("feat1"), "output shows feat1 tag");
  }

  // 9. pkglab restore from consumer-1
  heading("9. pkglab restore @test/pkg-a (consumer-1)");
  {
    const r = await pkglab(["restore", "@test/pkg-a"], { cwd: consumer1Dir });
    assert(r.code === 0, "pkglab restore succeeds");

    const pkg = await readPkgJson(consumer1Dir);
    const ver = getDep(pkg, "@test/pkg-a");
    // Original was empty (added by pkglab), so dep should be removed
    assert(!ver, "dependency removed after pkglab restore");
  }

  // 10. pkglab check from consumer-2 (should find artifacts)
  heading("10. pkglab check (consumer-2, should find artifacts)");
  {
    const r = await pkglab(["check"], { cwd: consumer2Dir });
    assert(r.code !== 0, "pkglab check exits non-zero (found artifacts)");
  }

  // 10b. repo reset --all skips missing dirs, reset deletes repo state
  heading("10b. repo reset (missing dirs + cleanup)");
  {
    // consumer-1 was already removed via `pkglab restore`, re-add so we have a repo to reset
    const addR = await pkglab(["add", "@test/pkg-a"], { cwd: consumer1Dir });
    assert(addR.code === 0, "re-add @test/pkg-a to consumer-1");

    // Verify both repos show up
    const lsBefore = await pkglab(["repo", "ls"]);
    assert(lsBefore.stdout.includes("consumer-1"), "consumer-1 in repo ls");
    assert(lsBefore.stdout.includes("consumer-2"), "consumer-2 in repo ls");

    // Delete consumer-1 dir to simulate a missing directory
    await rm(consumer1Dir, { recursive: true, force: true });

    // reset --all should skip consumer-1 (missing) and reset consumer-2 (exists)
    const resetR = await pkglab(["repo", "reset", "--all"]);
    assert(resetR.code === 0, "reset --all succeeds");
    assert(resetR.stdout.includes("Skipping"), "skips repo with missing dir");
    assert(resetR.stdout.includes("Reset"), "resets repo with existing dir");

    // consumer-2 should be gone from repo ls (reset deletes state)
    const lsAfter = await pkglab(["repo", "ls"]);
    assert(!lsAfter.stdout.includes("consumer-2"), "consumer-2 removed after reset");

    // consumer-1 stale entry should still be there
    assert(lsAfter.stdout.includes("consumer-1"), "consumer-1 stale entry still in list");

    // --stale should clean it up
    const staleR = await pkglab(["repo", "reset", "--stale"]);
    assert(staleR.code === 0, "reset --stale succeeds");
    assert(staleR.stdout.includes("Removed stale"), "stale repo removed");

    // repo ls should now be empty
    const lsFinal = await pkglab(["repo", "ls"]);
    assert(lsFinal.stdout.includes("No linked repos"), "all repos cleaned up");

    // Recreate consumer-1 for remaining tests
    await mkdir(consumer1Dir, { recursive: true });
    await writeJson(join(consumer1Dir, "package.json"), {
      name: "consumer-1",
      version: "1.0.0",
      dependencies: {},
    });
    const bunInit = Bun.spawn(["bun", "install"], {
      cwd: consumer1Dir,
      stdout: "ignore",
      stderr: "ignore",
    });
    await bunInit.exited;
  }

  // 11. Test --worktree flag (from a git repo)
  heading("11. pkglab pub --worktree");
  {
    // Init git in producer so --worktree can detect branch
    for (const cmd of [
      ["git", "init", "-b", "feat/test-branch"],
      ["git", "add", "."],
      ["git", "-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", "init", "--allow-empty"],
    ]) {
      const p = Bun.spawn(cmd, { cwd: producerDir, stdout: "ignore", stderr: "ignore" });
      await p.exited;
    }

    const r = await pkglab(["pub", "-w"], { cwd: producerDir });
    assert(r.code === 0, "pkglab pub -w succeeds");

    // Verify the tag was sanitized from feat/test-branch to feat-test-branch
    const lsR = await pkglab(["pkg", "ls"]);
    assert(lsR.stdout.includes("feat-test-branch"), "worktree tag sanitized correctly");
  }

  // 12. Single-package pub includes deps and cascades to dependents of changed deps
  heading("12. pub single package includes deps but not dependents (no repos)");
  {
    // Touch files so fingerprinting detects changes
    await Bun.write(join(producerDir, "packages/pkg-a/index.js"), "// updated for test 12\n");
    await Bun.write(join(producerDir, "packages/pkg-b/index.js"), "// updated for test 12\n");
    await Bun.write(join(producerDir, "packages/pkg-c/index.js"), "// updated for test 12\n");

    const r = await pkglab(["pub", "@test/pkg-b"], { cwd: producerDir });
    assert(r.code === 0, "pkglab pub @test/pkg-b succeeds");
    // pkg-b depends on pkg-a, so pkg-a is in scope as a dependency.
    // No active repos = no dependent expansion, so pkg-c is NOT included.
    assert(r.stdout.includes("@test/pkg-a"), "dependency @test/pkg-a included in publish");
    assert(r.stdout.includes("@test/pkg-b"), "@test/pkg-b included in publish");
    assert(!r.stdout.includes("@test/pkg-c"), "pkg-c excluded (no active repos)");
    assert(r.stdout.includes("2 packages"), "publishes 2 packages (target + dep)");
  }

  // 12b. Unchanged dep does NOT cascade to its dependents
  heading("12b. unchanged dep skips cascade");
  {
    // After test 12, pkg-a and pkg-b have fingerprint state.
    // Touch ONLY pkg-b (not pkg-a). Publishing pkg-b should include
    // pkg-a as a dep (unchanged). pkg-c is excluded (no active repos).
    await Bun.write(join(producerDir, "packages/pkg-b/index.js"), "// updated for test 12b\n");

    const r = await pkglab(["pub", "@test/pkg-b"], { cwd: producerDir });
    assert(r.code === 0, "pkglab pub @test/pkg-b succeeds");
    assert(r.stdout.includes("@test/pkg-a"), "dep @test/pkg-a in scope");
    assert(r.stdout.includes("@test/pkg-b"), "@test/pkg-b in scope");
    // pkg-c should NOT appear because pkg-a is unchanged
    assert(!r.stdout.includes("@test/pkg-c"), "pkg-c excluded (dep pkg-a unchanged)");
    assert(r.stdout.includes("1 to publish"), "only 1 package to publish (pkg-b)");
  }

  // 13. Single-package pub without repos only publishes target
  heading("13. pub single package without repos (no dependents)");
  {
    // pkg-a has no deps. pkg-b and pkg-c depend on it, but with no active repos
    // there's no dependent expansion, so only pkg-a is published.
    await Bun.write(join(producerDir, "packages/pkg-a/index.js"), "// updated for test 13\n");

    const r = await pkglab(["pub", "@test/pkg-a"], { cwd: producerDir });
    assert(r.code === 0, "pkglab pub @test/pkg-a succeeds");
    assert(r.stdout.includes("@test/pkg-a"), "@test/pkg-a included in publish");
    assert(!r.stdout.includes("@test/pkg-b"), "pkg-b excluded (no active repos)");
    assert(!r.stdout.includes("@test/pkg-c"), "pkg-c excluded (no active repos)");
    assert(r.stdout.includes("1 packages"), "publishes 1 package (target only)");
  }

  // 14. Test error: add with non-existent tag
  heading("14. Error: add with non-existent tag");
  {
    const r = await pkglab(["add", "@test/pkg-a@nonexistent"], { cwd: consumer1Dir });
    assert(r.code !== 0, "pkglab add with bad tag fails");
  }

  // 15. Test error: --tag and --worktree together
  heading("15. Error: --tag and --worktree together");
  {
    const r = await pkglab(["pub", "-t", "foo", "-w"], { cwd: producerDir });
    assert(r.code !== 0, "pub with both --tag and --worktree fails");
  }

  // 16. Consumer-aware cascade filtering
  heading("16. Consumer-aware filtering: skip unconsumed dependents");
  {
    // Publish all so everything has fingerprint state
    await Bun.write(join(producerDir, "packages/pkg-a/index.js"), "// updated for test 16 setup\n");
    await Bun.write(join(producerDir, "packages/pkg-b/index.js"), "// updated for test 16 setup\n");
    await Bun.write(join(producerDir, "packages/pkg-c/index.js"), "// updated for test 16 setup\n");
    const setup = await pkglab(["pub"], { cwd: producerDir });
    assert(setup.code === 0, "full pub for test 16 setup");

    // Add only pkg-b to consumer-1 (consumer has pkg-b but NOT pkg-c)
    const addR = await pkglab(["add", "@test/pkg-b"], { cwd: consumer1Dir });
    assert(addR.code === 0, "add @test/pkg-b to consumer-1");

    // Touch only pkg-a to force a change
    await Bun.write(join(producerDir, "packages/pkg-a/index.js"), "// updated for test 16\n");

    // Publish just pkg-a: should cascade to pkg-b (consumed) but skip pkg-c (not consumed)
    const r = await pkglab(["pub", "@test/pkg-a"], { cwd: producerDir });
    assert(r.code === 0, "pub @test/pkg-a succeeds");
    assert(r.stdout.includes("@test/pkg-a"), "pkg-a published");
    assert(r.stdout.includes("@test/pkg-b"), "pkg-b published (consumed dependent)");
    assert(r.stdout.includes("2 packages"), "only 2 packages published (pkg-c filtered)");
    assert(r.stdout.includes("no consumers"), "mentions filtered dependents");

    // Clean up: remove pkg-b from consumer
    await pkglab(["restore", "@test/pkg-b"], { cwd: consumer1Dir });
  }

  heading("17. Nested package install with -p flag");
  {
    // Create a bun workspace consumer with apps/web sub-package
    const wsConsumerDir = join(testDir, "ws-consumer");
    await mkdir(join(wsConsumerDir, "apps/web"), { recursive: true });

    // Workspace root
    await writeJson(join(wsConsumerDir, "package.json"), {
      name: "ws-consumer",
      private: true,
      workspaces: ["apps/*"],
    });

    // Sub-package (include @test/pkg-a so -p can update it)
    await writeJson(join(wsConsumerDir, "apps/web/package.json"), {
      name: "web-app",
      version: "1.0.0",
      dependencies: {
        "@test/pkg-a": "0.0.0",
      },
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(["bun", "install"], {
      cwd: wsConsumerDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    await bunInit.exited;

    // Add @test/pkg-a targeting the sub-package
    const addR = await pkglab(["add", "@test/pkg-a", "-p", "apps/web"], { cwd: wsConsumerDir });
    assert(addR.code === 0, "pkglab add -p apps/web succeeds");

    // Verify version is in sub-package, not root
    const webPkg = await readPkgJson(join(wsConsumerDir, "apps/web"));
    const rootPkg = await readPkgJson(wsConsumerDir);
    assert(!!getDep(webPkg, "@test/pkg-a"), "sub-package has @test/pkg-a");
    assert(!getDep(rootPkg, "@test/pkg-a"), "root does NOT have @test/pkg-a");

    // Touch a file and republish to trigger consumer update
    await Bun.write(join(producerDir, "packages/pkg-a/index.js"), "// updated for test 17\n");
    const pubR = await pkglab(["pub", "@test/pkg-a"], { cwd: producerDir });
    assert(pubR.code === 0, "pub succeeds");
    assert(pubR.stdout.includes("ws-consumer"), "ws-consumer mentioned in update output");

    // Verify sub-package was updated (different version now)
    const webPkgAfter = await readPkgJson(join(wsConsumerDir, "apps/web"));
    const verBefore = getDep(webPkg, "@test/pkg-a")!;
    const verAfter = getDep(webPkgAfter, "@test/pkg-a")!;
    assert(verAfter !== verBefore, "sub-package version updated after pub");
    assert(verAfter.includes("0.0.0-pkglab."), "new version is pkglab format");

    // Restore and verify
    const restoreR = await pkglab(["restore", "--all"], { cwd: wsConsumerDir });
    assert(restoreR.code === 0, "restore succeeds");

    // Clean up ws-consumer from repo state
    await pkglab(["repo", "reset", "--stale"]).catch(() => {});
  }

  heading("18. Bun catalog support");
  {
    // Create a bun workspace consumer with catalog
    const catConsumerDir = join(testDir, "cat-consumer");
    await mkdir(join(catConsumerDir, "apps/main"), { recursive: true });

    // Workspace root with catalog (use a real package for initial install)
    await writeJson(join(catConsumerDir, "package.json"), {
      name: "cat-consumer",
      private: true,
      workspaces: ["apps/*"],
      catalog: {
        "@test/pkg-a": "0.0.0",
      },
    });

    // Sub-package (no deps that would fail to resolve)
    await writeJson(join(catConsumerDir, "apps/main/package.json"), {
      name: "main-app",
      version: "1.0.0",
      dependencies: {},
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(["bun", "install"], {
      cwd: catConsumerDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    await bunInit.exited;

    // Add @test/pkg-a with --catalog flag
    const addR = await pkglab(["add", "@test/pkg-a", "--catalog"], { cwd: catConsumerDir });
    assert(addR.code === 0, "pkglab add --catalog succeeds");

    // Verify catalog was updated in root package.json
    const rootPkg = await readPkgJson(catConsumerDir);
    assert(
      rootPkg.catalog["@test/pkg-a"].includes("0.0.0-pkglab."),
      "catalog entry updated to pkglab version",
    );

    // Touch a file and republish to trigger consumer update
    await Bun.write(join(producerDir, "packages/pkg-a/index.js"), "// updated for test 18\n");
    const pubR = await pkglab(["pub", "@test/pkg-a"], { cwd: producerDir });
    assert(pubR.code === 0, "pub succeeds");
    assert(pubR.stdout.includes("cat-consumer"), "cat-consumer mentioned in update output");

    // Verify catalog version was updated again
    const rootPkgAfter = await readPkgJson(catConsumerDir);
    assert(
      rootPkgAfter.catalog["@test/pkg-a"] !== rootPkg.catalog["@test/pkg-a"],
      "catalog version changed after pub",
    );

    // Restore and verify catalog is back to original
    const restoreR = await pkglab(["restore", "--all"], { cwd: catConsumerDir });
    assert(restoreR.code === 0, "restore succeeds");

    const rootPkgRestored = await readPkgJson(catConsumerDir);
    assert(
      rootPkgRestored.catalog["@test/pkg-a"] === "0.0.0",
      "catalog restored to original version",
    );

    // Clean up
    await pkglab(["repo", "reset", "--stale"]).catch(() => {});
  }

  heading("Results");
  console.log(`  ${passed} passed, ${failed} failed`);
} finally {
  // Cleanup
  heading("Cleanup");
  await pkglab(["repo", "reset", "--all"]).catch(() => {});
  await pkglab(["pkg", "rm", "@test/pkg-a", "@test/pkg-b", "@test/pkg-c"]).catch(() => {});
  await pkglab(["down"]).catch(() => {});
  await rm(testDir, { recursive: true, force: true });
  await pkglab(["repo", "reset", "--stale"]).catch(() => {});
  console.log(`  Removed ${testDir}`);
}

process.exit(failed > 0 ? 1 : 0);
