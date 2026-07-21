test("real Runner supervises a declared local review server through exact-head exit evaluation", async () => {
  const scenario = new ReviewServerScenario();
  try {
    const result = await scenario.play();
    const phases = result.frames.map((item) => item.visual.phase);
    const final = result.frames.at(-1)!;
    const healthy = result.frames.find((item) => item.visual.phase === "healthy")!;

    assert.deepEqual(phases, ["ready", "committed", "healthy", "exit-received-url", "stopped"]);
    assert.equal(final.receipts[0].status, "advance");
    assert.equal(final.visual.server?.alive, false);
    assert.deepEqual(final.visual.server?.args, ["run", "workbench"]);
    assert.equal(final.visual.server?.cwd, final.visual.workspace);
    assert.equal(final.assertions.every((item) => item.passed), true);
    await assert.rejects(fetch(healthy.visual.server!.url));
  } finally {
    scenario.dispose();
  }
});

test("review supervisor rejects an uncommitted workspace before launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-dirty-review-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { workbench: "node server.ts" } }));
    writeFileSync(join(root, "server.ts"), "throw new Error('must not launch');\n");
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "factorio@example.test"]);
    git(root, ["config", "user.name", "Factorio Fixture"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "Initial fixture"]);
    writeFileSync(join(root, "dirty.txt"), "not committed\n");
    await assert.rejects(new ReviewServerSupervisor().start("dirty-run", root), /clean committed workspace head/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

import { ReviewServerScenario } from "../test/harness/ReviewServerScenario.ts";
import { ReviewServerSupervisor } from "../src/ReviewServerSupervisor.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
