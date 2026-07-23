test("happy-path Viewer scenario keeps the project row stable while expanding sorted blobs", () => {
  const scenario = new HappyPathViewerScenario();
  const before = scenario.snapshot().frames[0];
  const after = scenario.play().frames[0];

  assert.equal((before.visual as { phase: string }).phase, "collapsed");
  assert.equal((after.visual as { phase: string }).phase, "expanded");
  assert.deepEqual((after.visual as { projects: string[] }).projects, ["Alpha project", "Beta project", "Zulu project"]);
  assert.deepEqual(
    (after.blobs as Array<{ id: string }>).map((blob) => blob.id),
    ["complete", "review", "failed"],
  );
  assert.equal((after.assertions as Array<{ passed: boolean }>).every((item) => item.passed), true);
});

import { HappyPathViewerScenario } from "../test/harness/HappyPathViewerScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
