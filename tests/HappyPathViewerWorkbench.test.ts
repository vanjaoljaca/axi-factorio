test("happy-path Viewer scenario keeps the project row stable while expanding sorted blobs", () => {
  const scenario = new HappyPathViewerScenario();
  const before = scenario.snapshot().frames[0];
  const after = scenario.play().frames[0];

  assert.equal((before.visual as { phase: string }).phase, "collapsed");
  assert.equal((after.visual as { phase: string }).phase, "expanded");
  assert.deepEqual((after.visual as { projects: string[] }).projects, ["Alpha project", "Beta project", "Zulu project"]);
  assert.deepEqual(
    (after.blobs as Array<{ id: string }>).map((blob) => blob.id),
    ["candidate-complete", "candidate-beta", "candidate-alpha"],
  );
  assert.equal((after.assertions as Array<{ passed: boolean }>).every((item) => item.passed), true);
  const workbench = readFileSync(join(import.meta.dirname, "..", "src", "WorkbenchServer.ts"), "utf8");
  assert.match(workbench, /state:blob\.state==="complete"\?"complete":"quiet"/u);
  assert.doesNotMatch(workbench, /happyPathViewerVisual[^]*statusLabel\(blob\.status\)/u);
});

import { HappyPathViewerScenario } from "../test/harness/HappyPathViewerScenario.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
