test("continuous Play carries a blob through every automatic step", async () => {
  const fixture = createExecutionFixture(["g1.first", "g2.second", "g3.third"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");

  while (await fixture.runner.runOnce()) {}

  assert.equal(fixture.store.getBlob("blob-1")?.state, "complete");
  assert.deepEqual(
    fixture.store.listReceipts("blob-1").map((receipt) => receipt.stepId),
    ["g1.first", "g2.second", "g3.third"],
  );
  fixture.database.close();
});

test("continuous Play halts at a human gate and resumes in the same step", async () => {
  const fixture = createExecutionFixture(["g1.review", "g2.finish"], ["blocked", "advance", "advance"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.armHumanGate("blob-1", "Review this.");
  fixture.store.requestContinuous("blob-1");

  await fixture.runner.runOnce();

  assert.deepEqual(executionState(fixture), ["g1.review", true, false]);
  assert.equal(await fixture.runner.runOnce(), false);
  fixture.store.approveHumanGate("blob-1", "Approved.", ["head:abc"]);
  await fixture.runner.runOnce();
  await fixture.runner.runOnce();

  const receipts = fixture.store.listReceipts("blob-1");
  assert.equal(receipts[1].continuationThreadId, receipts[0].externalRunId);
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["blocked", "advance", "advance"]);
  assert.equal(fixture.store.getBlob("blob-1")?.state, "complete");
  fixture.database.close();
});

test("Step executes exactly one transition and stays stopped", async () => {
  const fixture = createExecutionFixture(["g1.first", "g2.second", "g3.third"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestStep("blob-1");

  assert.equal(await fixture.runner.runOnce(), true);
  assert.deepEqual(executionState(fixture), ["g2.second", false, false]);
  assert.equal(fixture.store.getBlob("blob-1")?.executionMode, "step");
  assert.equal(await fixture.runner.runOnce(), false);

  fixture.store.requestStep("blob-1");
  await fixture.runner.runOnce();
  assert.deepEqual(executionState(fixture), ["g3.third", false, false]);
  fixture.database.close();
});

test("failure halts continuous execution until an explicit retry", async () => {
  const fixture = createExecutionFixture(["g1.first"], ["throw", "advance"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");

  await assert.rejects(fixture.runner.runOnce(), ReceiptRunError);
  assert.deepEqual(executionState(fixture), ["g1.first", true, false]);
  assert.equal(await fixture.runner.runOnce(), false);

  fixture.store.retryBlob("blob-1");
  await fixture.runner.runOnce();
  assert.equal(fixture.store.getBlob("blob-1")?.state, "complete");
  fixture.database.close();
});

test("duplicate starts are idempotent and Stop prevents the next claim", async () => {
  const adapter = new ControlledAdapter();
  const fixture = createExecutionFixture(["g1.first", "g2.second"], [], adapter);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  assert.equal(fixture.store.requestContinuous("blob-1").already, false);
  assert.equal(fixture.store.requestContinuous("blob-1").already, true);
  const running = fixture.runner.runOnce();
  await waitUntil(() => fixture.store.listReceipts("blob-1")[0]?.status === "running");

  assert.equal(fixture.store.requestContinuous("blob-1").already, true);
  assert.throws(() => fixture.store.requestStep("blob-1"), /already running/);
  assert.equal(fixture.store.requestStop("blob-1").already, false);
  adapter.release();
  await running;

  assert.deepEqual(executionState(fixture), ["g2.second", false, false]);
  assert.equal(await fixture.runner.runOnce(), false);
  assert.equal(fixture.store.listReceipts("blob-1").length, 1);
  fixture.database.close();
});

test("execution mode and requested work survive a database restart", async () => {
  const pipeline = createPipeline(["g1.first", "g2.second"]);
  const databasePath = join(pipeline.root, "factorio.sqlite");
  const firstDatabase = new FactorioDatabase(databasePath);
  const firstStore = new ConveyorStore(firstDatabase);
  firstStore.createBlob("blob-1", blobInput(pipeline));
  firstStore.requestContinuous("blob-1");
  firstDatabase.close();

  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  const blob = store.getBlob("blob-1");
  assert.equal(blob?.executionMode, "continuous");
  assert.equal(blob?.runRequested, true);
  const runner = new ConveyorRunner(store, new OutcomeAdapter());
  await runner.runOnce();
  assert.equal(store.getBlob("blob-1")?.state, "g2.second");
  assert.equal(store.getBlob("blob-1")?.runRequested, true);
  database.close();
});

function createExecutionFixture(
  steps: string[],
  outcomes: Outcome[] = [],
  adapter: ToolAdapter = new OutcomeAdapter(outcomes),
): ExecutionFixture {
  const pipeline = createPipeline(steps);
  const database = new FactorioDatabase(join(pipeline.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  return { ...pipeline, database, store, runner: new ConveyorRunner(store, adapter) };
}

function executionState(fixture: ExecutionFixture): [string, boolean, boolean] {
  const blob = fixture.store.getBlob("blob-1")!;
  return [blob.state, blob.paused, blob.runRequested];
}

function blobInput(fixture: PipelineFixture): BlobInput {
  return {
    title: "Execution control",
    body: "",
    cwd: fixture.root,
    pipelinePath: fixture.pipelinePath,
    inputArtifacts: [],
  };
}

class OutcomeAdapter implements ToolAdapter {
  readonly name = "fake";
  private readonly outcomes: Outcome[];
  private calls = 0;

  constructor(outcomes: Outcome[] = []) {
    this.outcomes = [...outcomes];
  }

  async execute(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<AdapterResult> {
    const externalRunId = input.continuationThreadId ?? `thread-${++this.calls}`;
    onExternalRun(externalRunId);
    const outcome = this.outcomes.shift() ?? "advance";
    if (outcome === "throw") throw new Error("adapter failed");
    return { status: outcome, reason: outcome, outputArtifacts: [], externalRunId };
  }
}

class ControlledAdapter extends OutcomeAdapter {
  private resolve!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });

  override async execute(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<AdapterResult> {
    await this.released;
    return super.execute(input, onExternalRun);
  }

  release(): void {
    this.resolve();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for execution state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Outcome = "advance" | "blocked" | "retry" | "throw";
type ExecutionFixture = PipelineFixture & {
  database: FactorioDatabase;
  store: ConveyorStore;
  runner: ConveyorRunner;
};

import type { AdapterInput, AdapterResult, BlobInput } from "../src/Types.ts";
import type { ExternalRunHandler, ToolAdapter } from "../src/Adapter.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { createPipeline } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorRunner, ReceiptRunError } from "../src/Runner.ts";
import { ConveyorStore } from "../src/Store.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
