test("Workbench project-removal scenario uses the real Store and keeps durable evidence", () => {
  const scenario = new ProjectRemovalScenario();
  try {
    const before = scenario.snapshot().frames[0];
    const after = scenario.remove().frames[0];
    const reset = scenario.reset().frames[0];

    assert.equal(before.visual.phase, "preview");
    assert.equal(before.visual.preview.blobCount, 2);
    assert.equal(before.visual.preview.receiptCount, 1);
    assert.equal(after.visual.phase, "removed");
    assert.equal(after.visual.auditCount, 1);
    assert.equal(after.assertions.every((item) => item.passed), true);
    assert.equal(reset.visual.phase, "preview");
  } finally {
    scenario.dispose();
  }
});

test("installed-runtime proof contract refuses the configured live database", () => {
  const liveDatabase = resolve("pipelines/axi-factorio.db");
  assert.throws(() => requireIsolatedProofDatabase(liveDatabase, liveDatabase), /isolated temporary database/u);
  const proof = createInstalledRuntimeProof(liveDatabase);
  try {
    assert.notEqual(proof.databasePath, liveDatabase);
    assert.equal(proof.databasePath.startsWith(tmpdir()), true);
  } finally {
    proof.dispose();
  }
});

import { ProjectRemovalScenario } from "../test/harness/ProjectRemovalScenario.ts";
import { createInstalledRuntimeProof, requireIsolatedProofDatabase } from "../src/InstalledRuntimeProof.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
