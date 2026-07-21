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

import { runCoupledService } from "../src/ServiceRuntime.ts";
import assert from "node:assert/strict";
import test from "node:test";
