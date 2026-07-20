test("service polls positioned blobs directly and processes new work", async () => {
  const fixture = createServiceFixture();
  const controller = new AbortController();
  const running = fixture.service.run(controller.signal);
  await delay(30);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");

  await waitUntil(() => fixture.store.getBlob("blob-1")?.state === "complete");
  controller.abort();
  await running;

  assert.equal(fixture.store.listReceipts("blob-1").length, 1);
  fixture.database.close();
});

test("service heartbeats while an adapter runs", async () => {
  const fixture = createServiceFixture(new SlowAdapter(), 300);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  const controller = new AbortController();
  const running = fixture.service.run(controller.signal);

  await waitUntil(() => fixture.store.listReceipts("blob-1")[0]?.status === "running");
  await delay(500);
  assert.equal(fixture.store.acquireLease("competitor", 100), false);
  await waitUntil(() => fixture.store.getBlob("blob-1")?.state === "complete");
  controller.abort();
  await running;
  fixture.database.close();
});

test("one-shot run refuses a competing dispatcher", async () => {
  const fixture = createServiceFixture();
  assert.equal(fixture.store.acquireLease("competitor", 1_000), true);
  await assert.rejects(
    fixture.service.runOnce(new AbortController().signal),
    /Another axi-factorio dispatcher owns the active lease/,
  );
  fixture.database.close();
});

test("service shutdown interrupts the receipt without changing its position", async () => {
  const fixture = createServiceFixture(new AbortableAdapter());
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  const controller = new AbortController();
  const running = fixture.service.run(controller.signal);

  await waitUntil(() => fixture.store.listReceipts("blob-1")[0]?.status === "running");
  controller.abort();
  await running;

  assert.equal(fixture.store.getBlob("blob-1")?.state, "plan.define");
  assert.equal(fixture.store.listReceipts("blob-1")[0].status, "interrupted");
  fixture.database.close();
});

test("service records a failure then continues to the next blob", async () => {
  const fixture = createServiceFixture(new FailOnceAdapter());
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.createBlob("blob-2", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  fixture.store.requestContinuous("blob-2");
  const controller = new AbortController();
  const running = fixture.service.run(controller.signal);

  await waitUntil(() => fixture.store.listBlobs().every((blob) => blob.state === "complete" || blob.paused));
  controller.abort();
  await running;

  assert.deepEqual(
    Object.fromEntries(fixture.store.listBlobs().map((blob) => [blob.id, [blob.state, blob.paused]])),
    { "blob-1": ["plan.define", true], "blob-2": ["complete", false] },
  );
  fixture.database.close();
});

class ServiceAdapter implements ToolAdapter {
  readonly name = "fake";

  async execute(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<AdapterResult> {
    onExternalRun(`run:${input.blob.id}`);
    return {
      status: "advance",
      reason: "done",
      outputArtifacts: [`artifact:${input.step.id}`],
      externalRunId: `run:${input.blob.id}`,
    };
  }
}

class SlowAdapter extends ServiceAdapter {
  override async execute(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<AdapterResult> {
    await delay(800);
    return super.execute(input, onExternalRun);
  }
}

class AbortableAdapter extends ServiceAdapter {
  override async execute(input: AdapterInput): Promise<AdapterResult> {
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class FailOnceAdapter extends ServiceAdapter {
  private shouldFail = true;

  override async execute(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<AdapterResult> {
    if (!this.shouldFail) return super.execute(input, onExternalRun);
    this.shouldFail = false;
    throw new Error("adapter failed");
  }
}

function createServiceFixture(
  adapter: ToolAdapter = new ServiceAdapter(),
  leaseMs = 500,
): ServiceFixture {
  const pipeline = createPipeline();
  const database = new FactorioDatabase(join(pipeline.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  const runner = new ConveyorRunner(store, adapter);
  return {
    ...pipeline,
    database,
    store,
    service: new ConveyorService(store, runner, 10, leaseMs),
  };
}

function blobInput(fixture: PipelineFixture): BlobInput {
  return {
    title: "Service blob",
    body: "Move it",
    cwd: fixture.root,
    pipelinePath: fixture.pipelinePath,
    inputArtifacts: [],
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for service.");
    await delay(10);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type ServiceFixture = PipelineFixture & {
  database: FactorioDatabase;
  store: ConveyorStore;
  service: ConveyorService;
};

import type { AdapterInput, AdapterResult, BlobInput } from "../src/Types.ts";
import type { ExternalRunHandler, ToolAdapter } from "../src/Adapter.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { createPipeline } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorRunner } from "../src/Runner.ts";
import { ConveyorService } from "../src/Service.ts";
import { ConveyorStore } from "../src/Store.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
