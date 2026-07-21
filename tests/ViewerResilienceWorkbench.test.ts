test("Workbench visibly reproduces and isolates a stale disposable project pipeline", () => {
  const scenario = runViewerResilienceScenario();
  const before = scenario.frames[0];
  const after = scenario.frames[1];

  assert.equal(before.blobs[0]?.id, "healthy-task");
  assert.equal(after.blobs[0]?.id, "healthy-task");
  assert(after.assertions.every((assertion) => assertion.passed));
  assert.match(
    after.evidenceCards.find((card) => card.label === "Visible project diagnosis")?.value ?? "",
    /Pipeline unavailable/u,
  );
});

import { runViewerResilienceScenario } from "../test/harness/ViewerResilienceScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
