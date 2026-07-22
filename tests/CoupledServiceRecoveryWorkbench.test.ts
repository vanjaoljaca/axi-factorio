test("Workbench exposes the coupled listener failure and stranded receipt lifecycle", async () => {
  const scenario = new CoupledServiceRecoveryScenario();
  const result = await scenario.play();
  const stranded = result.frames.find((frame) => frame.visual.phase === "stranded");
  const terminal = result.frames.at(-1)!;

  assert.equal(stranded, undefined);
  assert.equal(terminal.visual.phase, "reconciled");
  assert.equal(terminal.receipts[0]?.status, "interrupted");
  assert.equal(terminal.receipts.length, 1);
});

import { CoupledServiceRecoveryScenario } from "../test/harness/CoupledServiceRecoveryScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
