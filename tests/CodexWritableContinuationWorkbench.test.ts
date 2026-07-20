test("Workbench proves entry, same-task continuation, and exit are writable", async () => {
  const scenario = await runCodexWritableContinuationScenario();

  assert.deepEqual(scenario.receipts.map((receipt) => receipt.status), ["retry", "advance"]);
  assert.equal(scenario.artifact, "fixture:improved");
  assert.deepEqual(scenario.externalRunIds, ["thread-writable-fixture"]);
  assert(scenario.frames.at(-1)?.assertions.every((assertion) => assertion.passed));
});

import { runCodexWritableContinuationScenario } from "../test/harness/CodexWritableContinuationScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
