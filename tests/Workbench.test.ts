test("workbench catalog lists every test with an explicit visual representation", () => {
  const catalog = listVisualTests();
  const names = catalog.map((item) => item.name);

  assert.equal(catalog.length, 70);
  assert.equal(new Set(catalog.map((item) => item.category)).size, 14);
  assert(names.includes("default harness pushes a blob through the actual conveyor"));
  assert(catalog.every((item) => item.visualLabel && item.visualDescription));
  assert.equal(catalog.find((item) => item.category === "Cli")?.visualKind, "terminal-proof");
  assert.equal(catalog.find((item) => item.category === "Runner")?.visualKind, "conveyor-replay");
  assert.equal(catalog.find((item) => item.category === "Execution Controls")?.visualKind, "conveyor-replay");
  assert.equal(catalog.find((item) => item.category === "Service")?.visualKind, "service-timeline");
});

test("workbench runs the actual selected test and returns replayable proof frames", async () => {
  const selected = getVisualTest("pipeline-3");
  const result = await runVisualTest(selected);

  assert.equal(result.passed, true);
  assert.equal(result.exitCode, 0);
  assert(result.frames.length >= 2);
  assert.equal(result.frames.at(-1)?.status, "passed");
});

test("workbench defaults away from the user viewer and rejects its configured port", () => {
  assert.equal(workbenchPort(["node", "workbench"]), 4318);
  assert.equal(workbenchPort(["node", "workbench", "--port", "4319"]), 4319);
  assert.throws(
    () => workbenchPort(["node", "workbench", "--port", "4400", "--viewer-port", "4400"]),
    /conflicts with the user viewer port/,
  );
  assert.throws(() => workbenchPort(["node", "workbench", "--port", "4317"]), /conflicts/);
});

import {
  getVisualTest,
  listVisualTests,
  runVisualTest,
} from "../test/visual/TestCatalog.ts";
import { workbenchPort } from "../src/WorkbenchPort.ts";
import assert from "node:assert/strict";
import test from "node:test";
