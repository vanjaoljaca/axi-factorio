test("runs a generic adapter and records artifact flow", async () => {
  const fixture = createRunnerFixture(["plan.define"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");

  assert.equal(await fixture.runner.runOnce(), true);

  const receipt = fixture.store.listReceipts("blob-1")[0];
  assert.equal(fixture.store.getBlob("blob-1")?.state, "complete");
  assert.equal(receipt.adapter, "fake");
  assert.equal(receipt.externalRunId, "fake-run-1");
  assert.deepEqual(receipt.inputArtifacts, ["ticket:1"]);
  assert.deepEqual(receipt.outputArtifacts, ["artifact:plan.define"]);
  fixture.database.close();
});

test("an edited unexecuted step uses its current definition", async () => {
  const fixture = createRunnerFixture(["plan.define", "qa.check"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  await fixture.runner.runOnce();
  const qa = discoverPipeline(fixture.pipelinePath)[1];
  writeFileSync(qa.entryPath, "current QA definition");

  await fixture.runner.runOnce();

  assert.equal(fixture.adapter.inputs[1].definition.entry, "current QA definition");
  assert.notEqual(
    fixture.store.listReceipts("blob-1")[0].definitionHash,
    fixture.store.listReceipts("blob-1")[1].definitionHash,
  );
  fixture.database.close();
});

test("adding an earlier step does not pull passed work backward", async () => {
  const fixture = createRunnerFixture(["plan.define", "qa.check"]);
  renumberStep(fixture.pipelinePath, 0, 10, "plan.define");
  renumberStep(fixture.pipelinePath, 1, 20, "qa.check");
  commitAll(fixture.root, "renumber");
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  await fixture.runner.runOnce();
  writeStep(fixture.pipelinePath, 5, "research.context");
  commitAll(fixture.root, "insert earlier step");

  await fixture.runner.runOnce();

  assert.deepEqual(
    fixture.store.listReceipts("blob-1").map((receipt) => receipt.stepId),
    ["plan.define", "qa.check"],
  );
  assert.equal(fixture.store.getBlob("blob-1")?.state, "complete");
  fixture.database.close();
});

test("complete work stays complete when a later step is added", async () => {
  const fixture = createRunnerFixture(["plan.define"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  await fixture.runner.runOnce();
  writeStep(fixture.pipelinePath, 1, "qa.check");
  commitAll(fixture.root, "add later");

  assert.equal(await fixture.runner.runOnce(), false);
  assert.equal(fixture.store.listReceipts("blob-1").length, 1);
  assert.equal(fixture.store.getBlob("blob-1")?.state, "complete");
  fixture.database.close();
});

test("rewind makes the selected step runnable again with a new receipt", async () => {
  const fixture = createRunnerFixture(["plan.define", "qa.check"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");
  await fixture.runner.runOnce();
  await fixture.runner.runOnce();
  const qa = discoverPipeline(fixture.pipelinePath)[1];
  fixture.store.rewindBlob("blob-1", qa, discoverPipeline(fixture.pipelinePath));
  fixture.store.requestContinuous("blob-1");

  await fixture.runner.runOnce();

  const receipts = fixture.store.listReceipts("blob-1");
  assert.deepEqual(receipts.map((receipt) => receipt.stepId), ["plan.define", "qa.check", "qa.check"]);
  assert.ok(receipts[1].invalidatedAt);
  assert.equal(receipts[2].attempt, 2);
  assert.equal(receipts[2].invalidatedAt, null);
  fixture.database.close();
});

test("retry repeats a step and increments its attempt", async () => {
  const fixture = createRunnerFixture(["plan.define"], ["retry", "advance"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.requestContinuous("blob-1");

  await fixture.runner.runOnce();
  await fixture.runner.runOnce();

  assert.deepEqual(
    fixture.store.listReceipts("blob-1").map((receipt) => [receipt.attempt, receipt.status]),
    [[1, "retry"], [2, "advance"]],
  );
  fixture.database.close();
});

test("human review cycles reuse one external thread and retain approval provenance", async () => {
  const fixture = createRunnerFixture(["workbench.review"]);
  fixture.store.createBlob("blob-1", blobInput(fixture));
  fixture.store.armHumanGate("blob-1", "Show this in Workbench.");
  fixture.store.requestContinuous("blob-1");

  await fixture.runner.runOnce();
  fixture.store.addHumanFeedback("blob-1", "Tighten the empty state.", ["voice-note:1"]);
  await fixture.runner.runOnce();
  fixture.store.approveHumanGate("blob-1", "Approved at exact head.", ["git-head:abc"]);
  await fixture.runner.runOnce();

  const receipts = fixture.store.listReceipts("blob-1");
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["blocked", "blocked", "advance"]);
  assert.deepEqual(receipts.map((receipt) => receipt.externalRunId), ["fake-run-1", "fake-run-1", "fake-run-1"]);
  assert.equal(receipts[1].continuationThreadId, "fake-run-1");
  assert.equal(receipts[1].humanInputs[0].text, "Tighten the empty state.");
  assert.deepEqual(receipts[2].approvalEvidence?.evidence, ["git-head:abc"]);
  assert.equal(fixture.store.getBlob("blob-1")?.state, "complete");
  fixture.database.close();
});

class FakeAdapter implements AgentHarness {
  readonly name = "fake";
  readonly inputs: HarnessRunInput[] = [];
  private readonly outcomes: HarnessDecision[];

  constructor(outcomes: HarnessDecision[]) {
    this.outcomes = outcomes;
  }

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, null, observer);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, input.externalRunId, observer);
  }

  async cancel(): Promise<void> {}

  private async execute(
    input: HarnessRunInput,
    continuationThreadId: string | null,
    observer: HarnessObserver,
  ): Promise<HarnessResult> {
    this.inputs.push(input);
    const externalRunId = continuationThreadId ?? `fake-run-${this.inputs.length}`;
    observer.event({ type: "external-run", externalRunId });
    const status = this.outcomes.shift() ?? "advance";
    return {
      decision: status,
      reason: status,
      outputArtifacts: [`artifact:${input.step.id}`],
      externalRunId,
    };
  }
}

function createRunnerFixture(
  steps: string[],
  outcomes: HarnessDecision[] = [],
): RunnerFixture {
  const pipeline = createPipeline(steps);
  const database = new FactorioDatabase(join(pipeline.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  const adapter = new FakeAdapter(outcomes);
  return { ...pipeline, database, store, adapter, runner: new ConveyorRunner(store, adapter) };
}

function blobInput(fixture: PipelineFixture): BlobInput {
  return {
    title: "Test blob",
    body: "Do it",
    cwd: fixture.root,
    pipelinePath: fixture.pipelinePath,
    inputArtifacts: ["ticket:1"],
  };
}

function renumberStep(pipelinePath: string, from: number, to: number, id: string): void {
  const [group, name] = id.split(".");
  for (const kind of ["entry", "exit"]) {
    renameSync(
      join(pipelinePath, `${from}.${group}.${name}.${kind}.md`),
      join(pipelinePath, `${to}.${group}.${name}.${kind}.md`),
    );
  }
}

type RunnerFixture = PipelineFixture & {
  database: FactorioDatabase;
  store: ConveyorStore;
  adapter: FakeAdapter;
  runner: ConveyorRunner;
};

import type { BlobInput, HarnessDecision } from "../src/Types.ts";
import type {
  AgentHarness,
  HarnessObserver,
  HarnessResult,
  HarnessResumeInput,
  HarnessRunInput,
  HarnessStartInput,
} from "../src/Harness.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { commitAll, createPipeline, writeStep } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { discoverPipeline } from "../src/Pipeline.ts";
import { ConveyorRunner } from "../src/Runner.ts";
import { ConveyorStore } from "../src/Store.ts";
import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
