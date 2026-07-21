test("Workbench recovers an empty aborted launch with a fresh task inside one receipt", async () => {
  const scenario = await runEmptyLaunchRecoveryScenario();
  const receipt = scenario.receipts[0];

  assert.equal(scenario.receipts.length, 1);
  assert.equal(receipt.status, "advance");
  assert.equal(receipt.externalRunId, "provider:recovered-task");
  assert.equal(scenario.harness.starts, 2);
  assert.equal(scenario.harness.cancels, 1);
  assert(scenario.frames.at(-1)?.assertions.every((item) => item.passed));
});

import { runEmptyLaunchRecoveryScenario } from "../test/harness/EmptyLaunchRecoveryScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
