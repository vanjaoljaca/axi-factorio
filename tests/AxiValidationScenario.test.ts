test("AXI validation visibly runs all ten principles through actual CLI tests", async () => {
  const scenario = new AxiValidationScenario();
  const started = scenario.play().frames[0].visual;

  assert.equal(started.phase, "running");
  assert.equal(started.principles.length, 10);
  const completed = await waitForCompletion(scenario);
  assert.equal(completed.phase, "passed");
  assert(completed.principles.every((item) => item.status === "passed"));
});

async function waitForCompletion(scenario: AxiValidationScenario): Promise<AxiValidationVisual> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const visual = scenario.snapshot().frames[0].visual;
    if (visual.phase !== "running") return visual;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("AXI validation did not finish within 15 seconds.");
}

import { AxiValidationScenario, type AxiValidationVisual } from "../test/harness/AxiValidationScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
