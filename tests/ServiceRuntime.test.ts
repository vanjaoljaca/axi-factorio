test("a dispatcher failure closes the coupled Viewer so launchd can restart the unit", async () => {
  const controller = new AbortController();
  let viewerClosed = false;
  const viewer = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => {
    viewerClosed = true;
    resolve();
  }, { once: true }));
  const dispatcher = Promise.reject(new Error("dispatcher lease lost"));

  await assert.rejects(runCoupledService(controller, dispatcher, viewer), /dispatcher lease lost/);

  assert.equal(controller.signal.aborted, true);
  assert.equal(viewerClosed, true);
});

test("a stuck Viewer close cannot strand the launchd service after dispatcher failure", async () => {
  const controller = new AbortController();
  let releaseViewer!: () => void;
  const viewer = new Promise<void>((resolve) => releaseViewer = resolve);
  const dispatcher = Promise.reject(new Error("dispatcher lease lost"));

  const coupled = runCoupledService(controller, dispatcher, viewer, 20);
  const disposition = await Promise.race([
    coupled.then(() => "resolved", () => "rejected"),
    delay(75).then(() => "stranded"),
  ]);
  releaseViewer();
  await coupled.catch(() => undefined);

  assert.equal(disposition, "rejected");
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import { runCoupledService } from "../src/ServiceRuntime.ts";
import assert from "node:assert/strict";
import test from "node:test";
