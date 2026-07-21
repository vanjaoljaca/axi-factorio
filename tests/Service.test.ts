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
  const fixture = createServiceFixture(new SlowAdapter(), 1_000);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  const controller = new AbortController();
  const running = fixture.service.run(controller.signal);

  await waitUntil(() => fixture.store.listReceipts("blob-1")[0]?.status === "running");
  await delay(1_400);
  assert.equal(fixture.store.acquireLease("competitor", 100), false);
  await waitUntil(() => fixture.store.getBlob("blob-1")?.state === "complete");
  controller.abort();
  await running;
  fixture.database.close();
});

test("service heartbeats while a slow local endpoint reconciliation is in flight", async () => {
  const fixture = createServiceFixture(new ServiceAdapter(), 120);
  const original = fixture.serviceRunner.reconcileLocalEndpoints.bind(fixture.serviceRunner);
  fixture.serviceRunner.reconcileLocalEndpoints = async () => {
    await delay(280);
    await original();
  };
  const controller = new AbortController();
  const running = fixture.service.run(controller.signal);

  await delay(190);
  assert.equal(fixture.store.acquireLease("competing-service", 100), false);
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

test("long-running service waits out a prior dispatcher lease instead of flapping", async () => {
  const fixture = createServiceFixture(new ServiceAdapter(), 500);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  assert.equal(fixture.store.acquireLease("previous-service", 50), true);
  const controller = new AbortController();
  const running = fixture.service.run(controller.signal);

  await waitUntil(() => fixture.store.getBlob("blob-1")?.state === "complete");
  controller.abort();
  await running;

  assert.equal(fixture.store.listReceipts("blob-1").length, 1);
  fixture.database.close();
});

test("service shutdown interrupts the receipt without changing its position", async () => {
  const harness = new AbortableAdapter();
  const fixture = createServiceFixture(harness);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  const controller = new AbortController();
  const running = fixture.service.run(controller.signal);

  await waitUntil(() => fixture.store.listReceipts("blob-1")[0]?.status === "running");
  controller.abort();
  await running;

  assert.equal(fixture.store.getBlob("blob-1")?.state, "plan.define");
  assert.equal(fixture.store.listReceipts("blob-1")[0].status, "interrupted");
  assert.equal(fixture.store.getBlob("blob-1")?.paused, true);
  assert.equal(fixture.store.getBlob("blob-1")?.runRequested, false);
  assert.match(fixture.store.listReceipts("blob-1")[0].error ?? "", /aborted|Dispatcher stopped/i);
  assert.equal(harness.cancelled, true);
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

class ServiceAdapter implements AgentHarness {
  readonly name = "fake";

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, `run:${input.blob.id}`, observer);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, input.externalRunId, observer);
  }

  async cancel(): Promise<void> {}

  protected async execute(
    input: HarnessRunInput,
    externalRunId: string,
    observer: HarnessObserver,
  ): Promise<HarnessResult> {
    observer.event({ type: "external-run", externalRunId });
    return {
      decision: "advance",
      reason: "done",
      outputArtifacts: [`artifact:${input.step.id}`],
      externalRunId,
    };
  }
}

class SlowAdapter extends ServiceAdapter {
  protected override async execute(
    input: HarnessRunInput,
    externalRunId: string,
    observer: HarnessObserver,
  ): Promise<HarnessResult> {
    await delay(2_000);
    return super.execute(input, externalRunId, observer);
  }
}

class AbortableAdapter extends ServiceAdapter {
  cancelled = false;
  private reject: ((error: Error) => void) | null = null;

  protected override async execute(): Promise<HarnessResult> {
    return new Promise((_resolve, reject) => this.reject = reject);
  }

  override async cancel(): Promise<void> {
    this.cancelled = true;
    this.reject?.(Object.assign(new Error("aborted"), { name: "AbortError" }));
  }
}

class FailOnceAdapter extends ServiceAdapter {
  private shouldFail = true;

  protected override async execute(
    input: HarnessRunInput,
    externalRunId: string,
    observer: HarnessObserver,
  ): Promise<HarnessResult> {
    if (!this.shouldFail) return super.execute(input, externalRunId, observer);
    this.shouldFail = false;
    throw new Error("adapter failed");
  }
}

function createServiceFixture(
  adapter: AgentHarness = new ServiceAdapter(),
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
    serviceRunner: runner,
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
  const deadline = Date.now() + 5_000;
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
  serviceRunner: ConveyorRunner;
  service: ConveyorService;
};

import type { BlobInput } from "../src/Types.ts";
import type {
  AgentHarness,
  HarnessObserver,
  HarnessResult,
  HarnessResumeInput,
  HarnessRunInput,
  HarnessStartInput,
} from "../src/Harness.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { createPipeline } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorRunner } from "../src/Runner.ts";
import { ConveyorService } from "../src/Service.ts";
import { ConveyorStore } from "../src/Store.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
