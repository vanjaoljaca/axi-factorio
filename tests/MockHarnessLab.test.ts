test("Workbench mock lab visibly exercises production progression and persistence", async () => {
  const lab = new MockHarnessLab();
  try {
    let snapshot = await lab.action("step");
    assert.equal(snapshot.blob.state, "review.human");
    assert.equal(snapshot.receipts.length, 1);
    assert.equal(snapshot.blob.runRequested, false);

    await lab.action("play");
    snapshot = await lab.waitForIdle();
    assert.equal(snapshot.blob.state, "review.human");
    assert.equal(snapshot.receipts.at(-1)?.status, "blocked");

    snapshot = await lab.action("feedback");
    assert.equal(snapshot.receipts.at(-1)?.status, "blocked");
    assert.equal(snapshot.receipts.at(-1)?.continuationThreadId, "mock-run:learning-lab-blob:review.human");

    snapshot = await lab.action("restart");
    assert.equal(snapshot.blob.state, "review.human");
    assert(snapshot.events.length > 0);

    snapshot = await lab.action("approve");
    assert.equal(snapshot.blob.state, "complete");
    assert.equal(snapshot.receipts.filter((receipt) => receipt.status === "advance").length, 3);
    assert(snapshot.assertions.every((item) => item.passed));
  } finally {
    lab.dispose();
  }
});

test("Workbench learning loop preserves blob and prompt provenance across reruns", async () => {
  const lab = new MockHarnessLab();
  try {
    await lab.action("step");
    const first = lab.snapshot().attempts[0];

    lab.previewBlobEdit("Implement an improved request with exact evidence.");
    lab.saveBlobEdit();
    const before = lab.promptContent("entry");
    lab.previewPromptEdit("entry", `${before.trim()}\n\nUse the revised blob evidence.`);
    lab.savePromptEdit();
    const snapshot = await lab.action("rewind-step");

    assert.equal(snapshot.attempts.length, 2);
    assert.equal(snapshot.attempts[0].blobRevision.revision, 1);
    assert.equal(snapshot.attempts[1].blobRevision.revision, 2);
    assert.notEqual(snapshot.attempts[0].definition.contentHash, snapshot.attempts[1].definition.contentHash);
    assert.equal(snapshot.attempts[0].receipt.invalidatedAt === null, false);
    assert.equal(snapshot.attempts[0].inputSnapshot.body, first.inputSnapshot.body);
    assert(snapshot.assertions.every((assertion) => assertion.passed));
  } finally {
    lab.dispose();
  }
});

test("Workbench scenario catalog prepares every requested learning state", async () => {
  const lab = new MockHarnessLab();
  try {
    const ids = lab.snapshot().scenarioCatalog.map((scenario) => scenario.id);
    assert.deepEqual(ids, [
      "first-attempt", "blob-edit", "prompt-edit", "rerun", "compare",
      "retry", "bounded-retry", "bounded-human-feedback", "blocked", "failure", "improved", "cancel-invalid",
    ]);

    let snapshot = await lab.selectScenario("retry");
    assert.equal(snapshot.attempts.at(-1)?.decision, "retry");

    snapshot = await lab.selectScenario("bounded-retry");
    assert.equal(snapshot.receipts.length, 1);
    assert.equal(snapshot.receipts[0].status, "retry");
    assert.equal(snapshot.blob.executionMode, "continuous");
    assert.equal(snapshot.blob.runRequested, false);

    snapshot = await lab.selectScenario("bounded-human-feedback");
    assert.deepEqual(snapshot.receipts.map((receipt) => receipt.status), ["blocked", "blocked"]);
    assert.equal(snapshot.blob.executionMode, "continuous");
    assert.equal(snapshot.blob.runRequested, false);
    assert.equal(snapshot.humanInputs.at(-1)?.evidence[0], "human:authorized");

    snapshot = await lab.selectScenario("blocked");
    assert.equal(snapshot.attempts.at(-1)?.decision, "blocked");
    assert.equal(snapshot.humanInputs.at(-1)?.kind, "feedback");

    snapshot = await lab.selectScenario("improved");
    assert.equal(snapshot.attempts.length, 2);
    assert.equal(snapshot.attempts[0].decision, "retry");
    assert.equal(snapshot.attempts[1].decision, "advance");

    snapshot = await lab.selectScenario("cancel-invalid");
    assert.equal(snapshot.editor.valid, false);
    assert.match(snapshot.editor.error ?? "", /cannot be empty/);
  } finally {
    lab.dispose();
  }
});

test("Workbench mock lab exposes deterministic failure and retry", async () => {
  const lab = new MockHarnessLab();
  try {
    let snapshot = await lab.action("fail");
    assert.equal(snapshot.receipts.at(-1)?.status, "failed");
    assert.equal(snapshot.blob.paused, true);

    snapshot = await lab.action("retry");
    assert.notEqual(snapshot.receipts.at(-1)?.status, "failed");
    assert(snapshot.events.some((event) => event.name === "axi_factorio.harness.error"));
  } finally {
    lab.dispose();
  }
});

test("Workbench mock lab can stop and terminalize the active transition", async () => {
  const lab = new MockHarnessLab();
  try {
    const playing = await lab.action("play");
    assert.equal(playing.blob.runRequested, true);

    const stopped = await lab.action("stop");
    assert.equal(stopped.blob.state, "build.first");
    assert.equal(stopped.blob.paused, true);
    assert.equal(stopped.blob.runRequested, false);
    assert.equal(stopped.receipts.length, 1);
    assert.equal(stopped.receipts[0].status, "interrupted");
  } finally {
    lab.dispose();
  }
});

import { MockHarnessLab } from "../test/harness/MockHarnessLab.ts";
import assert from "node:assert/strict";
import test from "node:test";
