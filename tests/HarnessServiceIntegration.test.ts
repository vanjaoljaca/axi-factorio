test("real service and Viewer controls persist mock harness execution end to end", async () => {
  const pipeline = createPipeline(["build.first", "review.human", "ship.complete"]);
  const databasePath = join(pipeline.root, "factorio.sqlite");
  let database = new FactorioDatabase(databasePath);
  let store = new ConveyorStore(database);
  store.createBlob(blobId, blobInput(pipeline));
  const viewer = createViewerServer(databasePath);
  const baseUrl = await listen(viewer);

  await control(baseUrl, "play");
  await control(baseUrl, "stop");
  const firstController = new AbortController();
  let serviceDone = runService(store, firstController.signal);
  await delay(40);
  assert.equal(store.listReceipts(blobId).length, 0);

  await control(baseUrl, "step");
  await waitUntil(() => store.getBlob(blobId)?.state === "review.human");
  assert.equal(store.listReceipts(blobId).length, 1);
  assert.equal(store.getBlob(blobId)?.runRequested, false);

  store.armHumanGate(blobId, "Review the deterministic result.");
  await control(baseUrl, "play");
  await waitUntil(() => store.listReceipts(blobId).at(-1)?.status === "blocked");
  const firstReviewRun = store.listReceipts(blobId).at(-1)?.externalRunId;

  store.addHumanFeedback(blobId, "Revise once.", ["feedback:mock"]);
  await waitUntil(() => store.listReceipts(blobId).filter((receipt) =>
    receipt.stepId === "review.human").length === 2);
  assert.equal(store.listReceipts(blobId).at(-1)?.externalRunId, firstReviewRun);

  firstController.abort();
  await serviceDone;
  database.close();
  database = new FactorioDatabase(databasePath);
  store = new ConveyorStore(database);
  const secondController = new AbortController();
  serviceDone = runService(store, secondController.signal);

  store.approveHumanGate(blobId, "Approved.", ["head:mock"]);
  await waitUntil(() => store.getBlob(blobId)?.state === "complete");
  assert.equal(store.listReceipts(blobId).filter((receipt) => receipt.status === "advance").length, 3);
  assert(store.listExecutionEvents(blobId).some((event) => event.name === "axi_factorio.harness.resume"));

  secondController.abort();
  await serviceDone;
  await close(viewer);
  database.close();
});

async function runService(store: ConveyorStore, signal: AbortSignal): Promise<void> {
  const runner = new ConveyorRunner(store, new MockAgentHarness());
  await new ConveyorService(store, runner, 5, 300).run(signal);
}

async function control(baseUrl: string, action: "play" | "step" | "stop"): Promise<void> {
  const response = await fetch(`${baseUrl}/api/blobs/${blobId}/${action}`, { method: "POST" });
  assert.equal(response.status, 200, await response.text());
}

async function listen(server: ReturnType<typeof createViewerServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Viewer did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createViewerServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for persisted service state.");
    await delay(10);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function blobInput(pipeline: PipelineFixture): BlobInput {
  return {
    title: "Service mock", body: "", cwd: pipeline.root,
    pipelinePath: pipeline.pipelinePath, inputArtifacts: ["request:service-test"],
  };
}

const blobId = "mock-service-blob";

import type { BlobInput } from "../src/Types.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorRunner } from "../src/Runner.ts";
import { ConveyorService } from "../src/Service.ts";
import { ConveyorStore } from "../src/Store.ts";
import { createViewerServer } from "../src/ViewerServer.ts";
import { MockAgentHarness } from "../test/harness/MockHarness.ts";
import { createPipeline } from "./Fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
