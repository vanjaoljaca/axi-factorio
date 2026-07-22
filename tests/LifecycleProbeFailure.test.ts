test("bounded lifecycle probe failures cannot leave a receipt running forever", async () => {
  const scenario = await runLifecycleProbeFailureScenario();

  assert(scenario.probeCount >= 3);
  assert.equal(scenario.receipt.status, "failed");
  assert.equal(scenario.harnessCancelled, true);
  assert.match(scenario.receipt.error ?? "", /lifecycle probe failed 3 consecutive times/iu);
  assert(scenario.frames.at(-1)!.assertions.every((assertion) => assertion.passed));
});

import { runLifecycleProbeFailureScenario } from "../test/harness/LifecycleProbeFailureScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
