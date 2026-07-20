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
    assert.equal(snapshot.receipts.at(-1)?.continuationThreadId, "mock-run:mock-lab-blob:review.human");

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

test("Workbench mock lab can stop continuous play after the active transition", async () => {
  const lab = new MockHarnessLab();
  try {
    const playing = await lab.action("play");
    assert.equal(playing.blob.runRequested, true);

    const stopped = await lab.action("stop");
    assert.equal(stopped.blob.state, "review.human");
    assert.equal(stopped.blob.runRequested, false);
    assert.equal(stopped.receipts.length, 1);
  } finally {
    lab.dispose();
  }
});

import { MockHarnessLab } from "../test/harness/MockHarnessLab.ts";
import assert from "node:assert/strict";
import test from "node:test";
