test("Workbench shows artifact fan-out surviving evaluator loss and fanning into the next pip", async () => {
  const scenario = await runArtifactConveyorScenario();
  assert.equal(scenario.frames.length, 3);
  assert.deepEqual(scenario.receipts.map((receipt) => receipt.status), ["failed", "advance"]);
  assert.equal(scenario.receipts.at(-1)?.adapter, "artifact-presence");
  assert.equal(scenario.frames.at(-1)?.blobs[0].state, "build.next");
  assert(scenario.frames.at(-1)?.assertions.every((item) => item.passed));
});

import { runArtifactConveyorScenario } from "../test/harness/ArtifactConveyorScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
