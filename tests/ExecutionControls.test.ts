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

test("Step executes one transition without replacing the preferred continuous mode", async () => {
  const fixture = createExecutionFixture(["g1.first", "g2.second", "g3.third"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestStep("blob-1");

  assert.equal(await fixture.runner.runOnce(), true);
  assert.deepEqual(executionState(fixture), ["g2.second", false, false]);
  assert.equal(fixture.store.getBlob("blob-1")?.executionMode, "continuous");
  assert.equal(fixture.store.getBlob("blob-1")?.singleTransitionRequested, false);
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

test("terminal external state fails safely and retry starts a fresh run", async () => {
  const harness = new ReconcilingHarness();
  const fixture = createExecutionFixture(["g1.first"], [], harness, {
    reconcileEveryMs: 2, confirmTerminalAfterMs: 2,
  });
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestStep("blob-1");

  await fixture.runner.runOnce();
  fixture.store.addHumanFeedback("blob-1", "Continue after review.", ["review:1"]);

  await assert.rejects(fixture.runner.runOnce(), /external task was interrupted/);

  const failed = fixture.store.listReceipts("blob-1")[1];
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /external task was interrupted/);
  assert.deepEqual(executionState(fixture), ["g1.first", true, false]);
  fixture.store.retryBlob("blob-1");
  await fixture.runner.runOnce();

  const receipts = fixture.store.listReceipts("blob-1");
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["blocked", "failed", "blocked"]);
  assert.equal(receipts[2].continuationThreadId, null);
  assert.equal(receipts[2].externalRunId, "external:fresh");
  assert.deepEqual(executionState(fixture), ["g1.first", true, false]);
  assert.ok(fixture.store.listExecutionEvents("blob-1")
    .some((event) => event.name === "axi_factorio.harness.reconcile"));
  fixture.database.close();
});

test("empty-launch recovery is capped at one within-receipt restart", async () => {
  const harness = new RepeatedEmptyLaunchHarness();
  const fixture = createExecutionFixture(["g1.first"], [], harness, {
    reconcileEveryMs: 2, confirmTerminalAfterMs: 2,
  });
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestStep("blob-1");

  await assert.rejects(fixture.runner.runOnce(), /empty provider turn/);

  const receipts = fixture.store.listReceipts("blob-1");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, "failed");
  assert.equal(harness.starts, 2);
  assert.equal(harness.resumes, 0);
  assert.equal(harness.cancels, 3);
  fixture.database.close();
});

test("a provider task completing during terminal confirmation is not restarted", async () => {
  const harness = new ConfirmationRaceHarness();
  const fixture = createExecutionFixture(["g1.first"], [], harness, {
    reconcileEveryMs: 2, confirmTerminalAfterMs: 30,
  });
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestStep("blob-1");

  await fixture.runner.runOnce();

  assert.equal(fixture.store.listReceipts("blob-1")[0].status, "advance");
  assert.equal(harness.starts, 1);
  assert.equal(harness.cancels, 0);
  fixture.database.close();
});

test("provider progress invalidates a stale terminal observation", async () => {
  const harness = new ProgressDuringConfirmationHarness();
  const fixture = createExecutionFixture(["g1.first"], [], harness, {
    reconcileEveryMs: 2, confirmTerminalAfterMs: 20,
  });
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestStep("blob-1");

  await fixture.runner.runOnce();

  assert.equal(fixture.store.listReceipts("blob-1")[0].status, "advance");
  assert.equal(harness.cancels, 0);
  fixture.database.close();
});

test("Stop cancels an allocated receipt and prevents the next claim", async () => {
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
  await running;

  assert.deepEqual(executionState(fixture), ["g1.first", true, false]);
  assert.equal(await fixture.runner.runOnce(), false);
  assert.equal(fixture.store.listReceipts("blob-1").length, 1);
  assert.equal(fixture.store.listReceipts("blob-1")[0].status, "interrupted");
  assert.equal(adapter.cancelled, true);
  fixture.database.close();
});

test("one bounded retry preserves continuous preference without creating a third receipt", async () => {
  const fixture = createExecutionFixture(["g1.first"], ["retry", "retry"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  fixture.store.requestStep("blob-1");

  await fixture.runner.runOnce();

  const blob = fixture.store.getBlob("blob-1")!;
  assert.equal(blob.executionMode, "continuous");
  assert.equal(blob.runRequested, false);
  assert.equal(blob.singleTransitionRequested, false);
  assert.equal(fixture.store.listReceipts("blob-1").length, 1);
  assert.equal(await fixture.runner.runOnce(), false);
  fixture.database.close();
});

test("bounded failed-receipt retry survives restart and cannot cascade", async () => {
  const harness = new OutcomeHarness(["throw", "retry", "advance"]);
  const fixture = createExecutionFixture(["g1.first"], [], harness);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  await assert.rejects(fixture.runner.runOnce(), ReceiptRunError);

  fixture.store.retryBlob("blob-1", true);
  assert.equal(fixture.store.getBlob("blob-1")?.singleTransitionRequested, true);
  fixture.database.close();

  const database = new FactorioDatabase(join(fixture.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  const runner = new ConveyorRunner(store, harness);
  assert.equal(store.getBlob("blob-1")?.executionMode, "continuous");
  assert.equal(store.getBlob("blob-1")?.runRequested, true);
  assert.equal(store.getBlob("blob-1")?.singleTransitionRequested, true);

  await runner.runOnce();

  assert.deepEqual(store.listReceipts("blob-1").map((receipt) => receipt.status), ["failed", "retry"]);
  assert.deepEqual([
    store.getBlob("blob-1")?.paused,
    store.getBlob("blob-1")?.runRequested,
    store.getBlob("blob-1")?.executionMode,
  ], [false, false, "continuous"]);
  assert.equal(await runner.runOnce(), false);
  database.close();

  for (const outcome of ["blocked", "throw"] as const) {
    const outcomeHarness = new OutcomeHarness(["throw", outcome, "advance"]);
    const outcomeFixture = createExecutionFixture(["g1.first"], [], outcomeHarness);
    outcomeFixture.store.createBlob("blob-1", blobInput(outcomeFixture));
    outcomeFixture.store.requestContinuous("blob-1");
    await assert.rejects(outcomeFixture.runner.runOnce(), ReceiptRunError);
    outcomeFixture.store.retryBlob("blob-1", true);

    if (outcome === "throw") await assert.rejects(outcomeFixture.runner.runOnce(), ReceiptRunError);
    else await outcomeFixture.runner.runOnce();

    assert.deepEqual(
      outcomeFixture.store.listReceipts("blob-1").map((receipt) => receipt.status),
      ["failed", outcome === "throw" ? "failed" : "blocked"],
    );
    assert.equal(outcomeFixture.store.getBlob("blob-1")?.runRequested, false);
    assert.equal(await outcomeFixture.runner.runOnce(), false);
    outcomeFixture.database.close();
  }
});

test("record-only feedback followed by Step creates one bounded receipt at a human gate", async () => {
  const fixture = createExecutionFixture(["g1.review", "g2.finish"], ["blocked", "advance"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.armHumanGate("blob-1", "Review required.");
  fixture.store.requestContinuous("blob-1");
  fixture.store.requestStep("blob-1");
  await fixture.runner.runOnce();

  fixture.store.addHumanFeedback("blob-1", "Proceed once.", ["human:authorized"], false);
  assert.deepEqual(executionState(fixture), ["g1.review", false, false]);
  assert.equal(fixture.store.getBlob("blob-1")?.executionMode, "continuous");

  fixture.store.requestStep("blob-1");
  await fixture.runner.runOnce();

  const receipts = fixture.store.listReceipts("blob-1");
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["blocked", "blocked"]);
  assert.equal(receipts[1].continuationThreadId, receipts[0].externalRunId);
  assert.deepEqual(executionState(fixture), ["g1.review", true, false]);
  assert.equal(await fixture.runner.runOnce(), false);
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
  const runner = new ConveyorRunner(store, new OutcomeHarness());
  await runner.runOnce();
  assert.equal(store.getBlob("blob-1")?.state, "g2.second");
  assert.equal(store.getBlob("blob-1")?.runRequested, true);
  database.close();
});

function createExecutionFixture(
  steps: string[],
  outcomes: Outcome[] = [],
  adapter: AgentHarness = new OutcomeHarness(outcomes),
  options: RunnerOptions = {},
): ExecutionFixture {
  const pipeline = createPipeline(steps);
  const database = new FactorioDatabase(join(pipeline.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  return {
    ...pipeline, database, store,
    runner: new ConveyorRunner(store, adapter, undefined, options),
  };
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

class OutcomeHarness implements AgentHarness {
  readonly name = "fake";
  private readonly outcomes: Outcome[];
  private calls = 0;

  constructor(outcomes: Outcome[] = []) {
    this.outcomes = [...outcomes];
  }

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, observer, `thread-${++this.calls}`);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, observer, input.externalRunId);
  }

  async cancel(): Promise<void> {}

  protected async execute(
    _input: HarnessStartInput,
    observer: HarnessObserver,
    externalRunId: string,
  ): Promise<HarnessResult> {
    observer.event({ type: "external-run", externalRunId });
    const outcome = this.outcomes.shift() ?? "advance";
    if (outcome === "throw") throw new Error("adapter failed");
    return { decision: outcome, reason: outcome, outputArtifacts: [], externalRunId };
  }
}

class ControlledAdapter extends OutcomeHarness {
  cancelled = false;
  private resolve!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });

  protected override async execute(
    input: HarnessStartInput,
    observer: HarnessObserver,
    externalRunId: string,
  ): Promise<HarnessResult> {
    await this.released;
    return super.execute(input, observer, externalRunId);
  }

  release(): void {
    this.resolve();
  }

  override async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

class ReconcilingHarness extends OutcomeHarness {
  private reject: ((error: Error) => void) | null = null;
  private starts = 0;

  override async start(
    _input: HarnessStartInput,
    observer: HarnessObserver,
  ): Promise<HarnessResult> {
    this.starts += 1;
    if (this.starts > 1) {
      observer.event({ type: "external-run", externalRunId: "external:fresh" });
      return {
        decision: "advance", reason: "fresh task started safely",
        outputArtifacts: [], externalRunId: "external:fresh",
      };
    }
    observer.event({ type: "external-run", externalRunId: "external:interrupted" });
    return {
      decision: "blocked", reason: "awaiting review",
      outputArtifacts: [], externalRunId: "external:interrupted",
    };
  }

  override async resume(
    input: HarnessResumeInput,
    observer: HarnessObserver,
  ): Promise<HarnessResult> {
    observer.event({ type: "external-run", externalRunId: input.externalRunId });
    return new Promise((_resolve, reject) => this.reject = reject);
  }

  async reconcile(): Promise<HarnessExternalState> {
    return { status: "interrupted", reason: "external task was interrupted" };
  }

  override async cancel(): Promise<void> {
    this.reject?.(new Error("cancelled after reconciliation"));
  }
}

class RepeatedEmptyLaunchHarness extends OutcomeHarness {
  starts = 0;
  resumes = 0;
  cancels = 0;
  private reject: ((error: Error) => void) | null = null;

  override async start(_input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.starts += 1;
    observer.event({ type: "external-run", externalRunId: `external:empty:${this.starts}` });
    return new Promise((_resolve, reject) => this.reject = reject);
  }

  override async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.resumes += 1;
    observer.event({ type: "external-run", externalRunId: input.externalRunId });
    return new Promise((_resolve, reject) => this.reject = reject);
  }

  override async reconcile(): Promise<HarnessExternalState> {
    return { status: "interrupted", reason: "empty provider turn", recovery: "restart" };
  }

  override async cancel(): Promise<void> {
    this.cancels += 1;
    this.reject?.(new Error("cancelled empty provider turn"));
    this.reject = null;
  }
}

class ConfirmationRaceHarness extends OutcomeHarness {
  starts = 0;
  cancels = 0;

  override async start(_input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.starts += 1;
    observer.event({ type: "external-run", externalRunId: "external:still-starting" });
    await new Promise((resolve) => setTimeout(resolve, 12));
    return {
      decision: "advance", reason: "provider became productive during confirmation",
      outputArtifacts: [], externalRunId: "external:still-starting",
    };
  }

  override async reconcile(): Promise<HarnessExternalState> {
    return { status: "interrupted", reason: "provider state has not caught up", recovery: "restart" };
  }

  override async cancel(): Promise<void> {
    this.cancels += 1;
  }
}

class ProgressDuringConfirmationHarness extends OutcomeHarness {
  cancels = 0;

  override async start(_input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    observer.event({ type: "external-run", externalRunId: "external:phase-change" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    observer.event({ type: "status", status: "running", message: "exit" });
    await new Promise((resolve) => setTimeout(resolve, 18));
    return {
      decision: "advance", reason: "fresh phase activity superseded stale provider state",
      outputArtifacts: [], externalRunId: "external:phase-change",
    };
  }

  override async reconcile(): Promise<HarnessExternalState> {
    return { status: "interrupted", reason: "stale prior phase", recovery: "restart" };
  }

  override async cancel(): Promise<void> {
    this.cancels += 1;
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
type RunnerOptions = { reconcileEveryMs?: number; confirmTerminalAfterMs?: number };
type ExecutionFixture = PipelineFixture & {
  database: FactorioDatabase;
  store: ConveyorStore;
  runner: ConveyorRunner;
};

import type { BlobInput } from "../src/Types.ts";
import type {
  AgentHarness,
  HarnessExternalState,
  HarnessObserver,
  HarnessResult,
  HarnessResumeInput,
  HarnessStartInput,
} from "../src/Harness.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { createPipeline } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorRunner, ReceiptRunError } from "../src/Runner.ts";
import { ConveyorStore } from "../src/Store.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
