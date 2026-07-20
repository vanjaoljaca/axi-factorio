test("Workbench deliberately relocates one blob and executes its next receipt only in root B", async () => {
  const scenario = await runBlobWorkspaceRelocationScenario();

  assert.equal(scenario.cliStatus, 0);
  assert.equal(scenario.newCwd, scenario.projectRoot);
  assert.equal(scenario.nextReceiptCwd, scenario.newCwd);
  assert.equal(scenario.receipts.length, 2);
  assert.equal(scenario.history.length, 1);
  assert(scenario.frames.at(-1)?.assertions.every((assertion) => assertion.passed));
});

import { runBlobWorkspaceRelocationScenario } from "../test/harness/BlobWorkspaceRelocationScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
