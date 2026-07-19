test("default harness pushes a blob through the actual conveyor", async () => {
  const harness = createTestHarness();
  try {
    assert.deepEqual(harness.steps.map((step) => step.id), ["g1.first", "g2.second", "g3.third"]);
    harness.store.createBlob("blob-happy", {
      title: "Happy path", body: "", cwd: process.cwd(),
      pipelinePath: harness.pipelinePath, inputArtifacts: [],
    });

    while (harness.store.getBlob("blob-happy")?.state !== "complete") {
      assert.equal(await harness.runner.runOnce(), true);
    }

    assert.deepEqual(
      harness.store.listReceipts("blob-happy").map((receipt) => receipt.stepId),
      ["g1.first", "g2.second", "g3.third"],
    );
  } finally {
    harness.dispose();
  }
});

import { createTestHarness } from "../test/harness/CreateTestHarness.ts";
import assert from "node:assert/strict";
import test from "node:test";
