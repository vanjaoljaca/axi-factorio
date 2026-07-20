test("execution telemetry marks stale running receipts with explicit text and unknown usage", () => {
  const fixture = createPipeline(["g1.first"]);
  const database = new FactorioDatabase(join(fixture.root, "factorio.sqlite"));
  let now = "2026-07-20T00:00:00.000Z";
  const store = new ConveyorStore(database, () => now);
  const blob = store.createBlob("stale", {
    title: "Stale fixture",
    body: "",
    cwd: fixture.root,
    pipelinePath: fixture.pipelinePath,
    inputArtifacts: [],
  }).blob;
  store.requestStep(blob.id);
  now = "2026-07-20T00:00:01.000Z";
  const step = discoverPipeline(fixture.pipelinePath)[0];
  store.beginReceipt({
    blobId: blob.id,
    step,
    definition: snapshotDefinition(step, fixture.pipelinePath),
    adapter: "fixture",
    model: null,
    reasoningEffort: null,
    inputArtifacts: [],
  });

  const sessions = listExecutionSessions(store, new Date("2026-07-20T00:06:02.000Z"));
  const markup = liveExecutionMarkup(sessions);

  assert.equal(sessions[0].stale, true);
  assert.equal(sessions[0].elapsedMs, 361_000);
  assert.match(markup, /No recent progress for 5m or more — check session/u);
  assert.match(markup, /Unknown/u);
  database.close();
});

import { FactorioDatabase } from "../src/Database.ts";
import { listExecutionSessions, liveExecutionMarkup } from "../src/LiveExecutions.ts";
import { discoverPipeline, snapshotDefinition } from "../src/Pipeline.ts";
import { ConveyorStore } from "../src/Store.ts";
import { createPipeline } from "./Fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
