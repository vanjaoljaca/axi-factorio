test("Workbench recovers an empty aborted launch inside one receipt and external task", async () => {
  const scenario = await runEmptyLaunchRecoveryScenario();
  const receipt = scenario.receipts[0];

  assert.equal(scenario.receipts.length, 1);
  assert.equal(receipt.status, "advance");
  assert.equal(receipt.externalRunId, "provider:fresh-task");
  assert.equal(scenario.harness.starts, 1);
  assert.equal(scenario.harness.resumes, 1);
  assert.equal(scenario.harness.cancels, 1);
  assert(scenario.frames.at(-1)?.assertions.every((item) => item.passed));
});

import { runEmptyLaunchRecoveryScenario } from "../test/harness/EmptyLaunchRecoveryScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
