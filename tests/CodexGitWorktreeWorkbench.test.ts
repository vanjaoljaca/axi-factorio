test("Codex commits from a linked worktree with only resolved Git metadata writable", async () => {
  const scenario = await runCodexGitWorktreeScenario();

  assert.equal(scenario.receipts.at(-1)?.status, "advance");
  assert.notEqual(scenario.beforeHead, scenario.afterHead);
  assert.deepEqual(scenario.files, { app: true, sibling: true, outside: false });
  assert(scenario.frames.at(-1)?.assertions.every((assertion) => assertion.passed));
});

import { runCodexGitWorktreeScenario } from "../test/harness/CodexGitWorktreeScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
