test("happy-path Viewer scenario removes technical row noise without rewriting state", () => {
  const scenario = new HappyPathViewerScenario();
  const before = scenario.snapshot().frames[0];
  const after = scenario.play().frames[0];

  assert.equal((before.visual as { phase: string }).phase, "noisy");
  assert.equal((after.visual as { phase: string }).phase, "clean");
  assert.deepEqual(
    (after.blobs as Array<{ id: string }>).map((blob) => blob.id),
    ["complete", "review", "failed"],
  );
  assert.equal((after.assertions as Array<{ passed: boolean }>).every((item) => item.passed), true);
});

import { HappyPathViewerScenario } from "../test/harness/HappyPathViewerScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
