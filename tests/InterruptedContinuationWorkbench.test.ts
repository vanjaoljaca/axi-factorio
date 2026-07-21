test("Workbench proves an interrupted external task is replaced without moving the blob backward", async () => {
  const scenario = await runInterruptedContinuationScenario();
  const receipts = scenario.receipts;

  assert.equal(scenario.starts, 2);
  assert.equal(scenario.resumes, 1);
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["blocked", "failed", "blocked"]);
  assert.equal(receipts[2].continuationThreadId, null);
  assert.equal(receipts[2].externalRunId, "external:fresh");
  assert(scenario.frames.at(-1)?.assertions.every((item) => item.passed));
});

import { runInterruptedContinuationScenario } from "../test/harness/InterruptedContinuationScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
