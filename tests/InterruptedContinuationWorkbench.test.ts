test("Workbench proves an interrupted external task is replaced without moving the blob backward", async () => {
  const scenario = await runInterruptedContinuationScenario();
  const receipts = scenario.receipts;

  assert.equal(scenario.starts, 2);
  assert.equal(scenario.resumes, 0);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].status, "failed");
  assert.equal(receipts[1].continuationThreadId, null);
  assert.equal(receipts[1].externalRunId, "external:fresh");
  assert(scenario.frames.at(-1)?.assertions.every((item) => item.passed));
});

import { runInterruptedContinuationScenario } from "../test/harness/InterruptedContinuationScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
