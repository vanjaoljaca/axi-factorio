test("discovers ordered files with stable IDs independent of order", () => {
  const fixture = createPipeline(["plan.define", "plan.research"]);
  const steps = discoverPipeline(fixture.pipelinePath);

  assert.deepEqual(steps.map((step) => [step.order, step.id]), [
    [0, "plan.define"],
    [1, "plan.research"],
  ]);
});

test("snapshots the current Git SHA and entry/exit content hash", () => {
  const fixture = createPipeline();
  const step = discoverPipeline(fixture.pipelinePath)[0];
  const first = snapshotDefinition(step, fixture.pipelinePath);
  writeFileSync(step.entryPath, "changed current definition");
  const second = snapshotDefinition(step, fixture.pipelinePath);

  assert.equal(first.gitSha, second.gitSha);
  assert.notEqual(first.contentHash, second.contentHash);
  assert.equal(second.entry, "changed current definition");
});

test("rejects unpaired prompts and duplicate order numbers", () => {
  const unpaired = createPipeline();
  rmSync(join(unpaired.pipelinePath, "0.plan.define.exit.md"));
  assert.throws(() => discoverPipeline(unpaired.pipelinePath), /missing entry or exit/);

  const duplicate = createPipeline();
  writeStep(duplicate.pipelinePath, 0, "qa.check");
  assert.throws(() => discoverPipeline(duplicate.pipelinePath), /order 0 is used more than once/);
});

import { createPipeline, writeStep } from "./Fixtures.ts";
import { discoverPipeline, snapshotDefinition } from "../src/Pipeline.ts";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
