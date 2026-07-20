test("Workbench separates app identity from the Codex execution workspace", async () => {
  const scenario = await runCodexExecutionWorkspaceScenario();

  assert.equal(scenario.cliStatus, 0);
  assert.notEqual(scenario.projectRoot, scenario.executionWorkspaceRoot);
  assert.deepEqual(scenario.files, { plan: true, app: true, sibling: true, outside: false });
  assert.equal(scenario.receipts.at(-1)?.status, "advance");
  assert.equal(scenario.bindings.length, 1);
  assert(scenario.frames[0].assertions.every((assertion) => assertion.passed));
});

import { runCodexExecutionWorkspaceScenario } from "../test/harness/CodexExecutionWorkspaceScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
