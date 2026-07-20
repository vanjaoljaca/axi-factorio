test("Workbench visibly plays and resets a real in-flight Store and Runner execution", async () => {
  const scenario = new LiveExecutionScenario();
  try {
    const ready = scenario.snapshot().frames[0];
    assert.equal(ready.visual.phase, "ready");
    assert.equal(ready.blobs.length, 1);
    assert.equal(ready.blobs[0].stepId, "g1.first");
    assert.equal(ready.visual.executions.length, 1);
    assert.equal(ready.visual.executions[0].stale, true);
    assert.deepEqual(ready.visual.statusItems.map((item) => item.status), ["waiting"]);

    const queued = (await scenario.play()).frames[0];
    assert.equal(queued.visual.phase, "queued");
    assert.equal(queued.blobs[0].stepId, "g1.first");

    await waitUntil(() => scenario.snapshot().frames[0].visual.phase === "running");
    const running = scenario.snapshot().frames[0];
    const execution = running.visual.executions.find((item) => item.blobId === "visible-agent-session")!;
    assert.equal(running.visual.phase, "running");
    assert.equal(execution.projectName, "Example App");
    assert.equal(execution.blobId, "visible-agent-session");
    assert.equal(execution.stepId, "g1.first");
    assert.equal(execution.attempt, 1);
    assert.equal(execution.harness, "deterministic-agent");
    assert.equal(execution.sessionId, "agent-session:visible-agent-session:1");
    assert.equal(execution.status, "running");
    assert.equal(execution.executionWorkspace.length > 0, true);
    assert.deepEqual(running.visual.statusItems.map((item) => item.status), ["queued", "waiting"]);
    assert.deepEqual(running.blobs.map((blob) => blob.state), ["running"]);

    await pause(1_050);
    const active = scenario.snapshot().frames[0].visual.executions.find(
      (item) => item.blobId === "visible-agent-session",
    )!;
    assert.notEqual(active.lastProgressAt, execution.lastProgressAt);

    const resetWhileRunning = (await scenario.reset()).frames[0];
    assert.equal(resetWhileRunning.visual.phase, "ready");
    assert.equal(resetWhileRunning.visual.executions.length, 1);

    await scenario.play();
    await waitUntil(() => scenario.snapshot().frames[0].visual.phase === "retry");
    const retry = scenario.snapshot().frames[0];
    assert.equal(retry.blobs[0].stepId, "g1.first");
    const retryReceipt = retry.visual.executions.find(
      (item) => item.blobId === "visible-agent-session",
    )!;
    assert.equal(retryReceipt.status, "retry");
    assert.equal(retryReceipt.model, "fixture-v1");
    assert.equal(retryReceipt.reasoningEffort, "medium");
    assert.equal(retryReceipt.cachedInputTokens, 80);
    assert.equal(retryReceipt.totalTokens, 178);
    assert.equal(retryReceipt.finishedAt !== null, true);
    assert.equal(retryReceipt.elapsedMs > 0, true);
    assert.match(retryReceipt.terminalReason ?? "", /improved pass/u);

    await scenario.play();
    await waitUntil(() => scenario.snapshot().frames[0].visual.phase === "advanced");
    const advanced = scenario.snapshot().frames[0];
    assert.equal(advanced.blobs[0].stepId, "g2.second");
    assert.equal(advanced.visual.executions.length, 3);
    assert.equal(advanced.visual.executions[0].status, "advance");
    assert.equal(advanced.visual.executions[0].attempt, 2);
    assert.equal(advanced.visual.executions[0].sessionId, retryReceipt.sessionId);
    assert(advanced.receipts.some((receipt) =>
      receipt.blobId === "visible-agent-session" && receipt.status === "advance"));

    const reset = (await scenario.reset()).frames[0];
    assert.equal(reset.visual.phase, "ready");
    assert.equal(reset.receipts.length, 0);
  } finally {
    await scenario.dispose();
  }
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await pause(50);
  }
  throw new Error("Scenario did not complete.");
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import { LiveExecutionScenario } from "../test/harness/LiveExecutionScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
