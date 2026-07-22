test("Workbench happy path visibly plays work pips, human pips, feedback rerun, and fan-in", async () => {
  const scenario = new HappyPathPipsScenario();
  try {
    const snapshots = [scenario.snapshot()];
    for (let index = 0; index < 7; index += 1) snapshots.push(await scenario.play());
    const final = snapshots.at(-1)!.frames[0];
    assert.equal(final.blobs[0].state, "complete");
    assert.equal(final.visual.harnessCalls, 4);
    assert.equal(final.receipts.filter((receipt) => receipt.stepId.startsWith("human.")).length, 2);
    assert(final.assertions.every((assertion) => assertion.passed));
  } finally {
    scenario.dispose();
  }
});

import { HappyPathPipsScenario } from "../test/harness/HappyPathPipsScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
