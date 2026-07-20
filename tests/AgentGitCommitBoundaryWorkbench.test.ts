test("agent commits inside its assigned workspace with only Git-owned metadata added", async () => {
  const scenario = await runAgentGitCommitBoundaryScenario();

  assert.equal(scenario.receipts.at(-1)?.status, "advance");
  assert.notEqual(scenario.beforeHead, scenario.afterHead);
  assert.deepEqual(scenario.files, { app: true, sibling: true, outside: false });
  assert(scenario.frames.at(-1)?.assertions.every((assertion) => assertion.passed));
});

import { runAgentGitCommitBoundaryScenario } from "../test/harness/AgentGitCommitBoundaryScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
