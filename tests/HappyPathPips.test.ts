test("work pips, empty human pips, feedback rerun, and fan-in complete one happy path", async () => {
  const fixture = happyPipeline();
  const database = new FactorioDatabase(join(fixture.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  const harness = new HappyHarness();
  const runner = new ConveyorRunner(store, harness);
  store.createBlob(blobId, {
    title: "Synthetic dashboard", body: "Explore two directions, choose, then merge.",
    cwd: fixture.root, pipelinePath: fixture.pipelinePath, inputArtifacts: ["request:synthetic"],
  });

  await step(store, runner);
  await step(store, runner);
  assert.equal(store.getBlob(blobId)?.state, "human.choose");
  assert.equal(store.getBlob(blobId)?.paused, true);
  assert.equal(harness.calls.length, 2);

  const steps = discoverPipeline(fixture.pipelinePath);
  store.addHumanFeedbackForRerun(
    blobId, requireStep(steps, "codex.explore-presentation"), steps,
    "Make the presentation quieter.", ["human:direction"], false,
  );
  await step(store, runner);
  assert.equal(store.getBlob(blobId)?.state, "human.choose");
  assert.equal(harness.calls.at(-1)?.humanInputs[0]?.text, "Make the presentation quieter.");

  store.approveHumanGate(blobId, "Use the revised direction.", ["human:approved-choice"], false);
  assert.equal(store.getBlob(blobId)?.state, "codex.merge");
  await step(store, runner);
  const merge = harness.calls.at(-1)!;
  assert(merge.inputArtifacts.includes("artifact:structure"));
  assert(merge.inputArtifacts.includes("artifact:presentation-v2"));
  assert(!merge.inputArtifacts.includes("artifact:presentation-v1"));
  assert.equal(store.getBlob(blobId)?.state, "human.accept");

  store.approveHumanGate(blobId, "Accepted.", ["human:accepted-demo"], false);
  assert.equal(store.getBlob(blobId)?.state, "complete");
  assert.equal(harness.calls.length, 4);
  const humanReceipts = store.listReceipts(blobId).filter((receipt) => receipt.executionKind === "human");
  assert.deepEqual(humanReceipts.map((receipt) => receipt.stepId), ["human.choose", "human.accept"]);
  assert(humanReceipts.every((receipt) => receipt.adapter === "human-approval"));
  database.close();
});

async function step(store: ConveyorStore, runner: ConveyorRunner): Promise<void> {
  store.requestStep(blobId);
  await runner.runBlob(blobId);
}

function happyPipeline(): PipelineFixture {
  const fixture = createPipeline([
    "codex.explore-structure", "codex.explore-presentation", "human.choose", "codex.merge", "human.accept",
  ]);
  writeStep(fixture.pipelinePath, 0, "codex.explore-structure", "Explore structure.", "");
  writeStep(fixture.pipelinePath, 1, "codex.explore-presentation", "Explore presentation.", "");
  writeStep(fixture.pipelinePath, 2, "human.choose", "", "");
  writeStep(fixture.pipelinePath, 3, "codex.merge", "Merge valid exploration artifacts.", "");
  writeStep(fixture.pipelinePath, 4, "human.accept", "", "");
  commitAll(fixture.root, "happy pips");
  return fixture;
}

class HappyHarness implements AgentHarness {
  readonly name = "happy-harness";
  readonly calls: HarnessStartInput[] = [];
  private presentationAttempt = 0;

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.calls.push(input);
    observer.event({ type: "external-run", externalRunId: `happy:${this.calls.length}` });
    return this.result(input);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.start(input, observer);
  }

  async cancel(): Promise<void> {}

  private result(input: HarnessStartInput): HarnessResult {
    if (input.step.id === "codex.explore-structure") return advance("artifact:structure");
    if (input.step.id === "codex.explore-presentation") {
      this.presentationAttempt += 1;
      return advance(`artifact:presentation-v${this.presentationAttempt}`);
    }
    return advance("artifact:merged-demo");
  }
}

function advance(artifact: string): HarnessResult {
  return { decision: "advance", reason: "happy path", outputArtifacts: [artifact], externalRunId: null };
}

const blobId = "happy-pips";

import type {
  AgentHarness, HarnessObserver, HarnessResult, HarnessResumeInput, HarnessStartInput,
} from "../src/Harness.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { discoverPipeline, requireStep } from "../src/Pipeline.ts";
import { ConveyorRunner } from "../src/Runner.ts";
import { ConveyorStore } from "../src/Store.ts";
import { commitAll, createPipeline, writeStep } from "./Fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
