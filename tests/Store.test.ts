test("stores blobs and complete execution receipts", () => {
  const fixture = createStoreFixture();
  const blob = fixture.store.createBlob("blob-1", blobInput(fixture)).blob;
  fixture.store.requestContinuous(blob.id);
  const step = discoverPipeline(fixture.pipelinePath)[0];
  const definition = snapshotDefinition(step, fixture.pipelinePath);
  const claim = fixture.store.beginReceipt({
    blobId: blob.id,
    step,
    definition,
    adapter: "fake",
    inputArtifacts: ["ticket:1"],
  });
  fixture.store.recordExternalRun(claim.receipt.id, "run-1");
  fixture.store.completeReceipt(claim.receipt.id, {
    status: "advance",
    reason: "done",
    outputArtifacts: ["commit:abc"],
    externalRunId: "run-1",
  }, null);

  const receipt = fixture.store.listReceipts(blob.id)[0];
  assert.equal(fixture.store.getBlob(blob.id)?.state, "complete");
  assert.equal(receipt.blobId, blob.id);
  assert.equal(receipt.stepId, "plan.define");
  assert.equal(receipt.status, "advance");
  assert.equal(receipt.definitionGitSha.length, 40);
  assert.equal(receipt.definitionHash.length, 64);
  assert.deepEqual(receipt.inputArtifacts, ["ticket:1"]);
  assert.deepEqual(receipt.outputArtifacts, ["commit:abc"]);
  assert.equal(receipt.externalRunId, "run-1");
  assert.ok(receipt.startedAt);
  assert.ok(receipt.finishedAt);
  fixture.database.close();
});

test("fresh storage includes projects, blobs, receipts, and the dispatcher lease", () => {
  const fixture = createStoreFixture();
  const rows = fixture.database.connection.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;

  assert.deepEqual(
    rows.map((row) => row.name),
    ["blobs", "dispatcherLeases", "humanInputs", "projects", "receipts"],
  );
  fixture.database.close();
});

test("identical adds and ready retries are idempotent", () => {
  const fixture = createStoreFixture();
  const first = fixture.store.createBlob("blob-1", blobInput(fixture));
  const second = fixture.store.createBlob("blob-1", blobInput(fixture));
  const retry = fixture.store.retryBlob("blob-1");

  assert.equal(first.already, false);
  assert.equal(second.already, true);
  assert.equal(retry.already, true);
  assert.equal(fixture.store.listReceipts("blob-1").length, 0);
  fixture.database.close();
});

test("adopt writes honest imported receipts for every attested prior step", () => {
  const fixture = createStoreFixture(["plan.define", "dev.build", "workbench.review"]);
  const blob = fixture.store.createBlob("blob-import", blobInput(fixture)).blob;
  const steps = discoverPipeline(fixture.pipelinePath);
  const attestations = steps.slice(0, 2).map((step) => ({
    step,
    definition: snapshotDefinition(step, fixture.pipelinePath),
    evidence: [`proof:${step.id}`],
  }));

  const adopted = fixture.store.adoptBlob(blob.id, steps[2], steps, "git-sha:abc123", attestations);
  const receipts = fixture.store.listReceipts(blob.id);

  assert.equal(adopted.state, "workbench.review");
  assert.equal(adopted.lastCompletedStepId, "dev.build");
  assert.deepEqual(receipts.map((receipt) => receipt.stepId), ["plan.define", "dev.build"]);
  assert(receipts.every((receipt) => receipt.executionKind === "imported"));
  assert(receipts.every((receipt) => receipt.adapter === "attested-import"));
  assert(receipts.every((receipt) => receipt.attestationSource === "git-sha:abc123"));
  fixture.database.close();
});

test("adopt rejects missing evidence, non-exact sources, and order gaps", () => {
  const fixture = createStoreFixture(["plan.define", "dev.build", "workbench.review"]);
  const blob = fixture.store.createBlob("blob-import", blobInput(fixture)).blob;
  const steps = discoverPipeline(fixture.pipelinePath);
  const attestation = (step: StepDefinition) => ({
    step, definition: snapshotDefinition(step, fixture.pipelinePath), evidence: [`proof:${step.id}`],
  });

  assert.throws(() => fixture.store.adoptBlob(blob.id, steps[2], steps, "HEAD", [
    attestation(steps[0]), attestation(steps[1]),
  ]), /exact kind:value/);
  assert.throws(() => fixture.store.adoptBlob(blob.id, steps[2], steps, "git-sha:abc", [
    attestation(steps[0]),
  ]), /cover every prior step/);
  assert.throws(() => fixture.store.adoptBlob(blob.id, steps[2], steps, "git-sha:abc", [
    attestation(steps[1]), attestation(steps[0]),
  ]), /out of order/);
  fixture.database.close();
});

test("rewind invalidates the target and later receipts", () => {
  const fixture = createStoreFixture(["plan.define", "dev.workbench", "qa.check"]);
  const blob = fixture.store.createBlob("blob-1", blobInput(fixture)).blob;
  fixture.store.requestContinuous(blob.id);
  const steps = discoverPipeline(fixture.pipelinePath);
  for (const [index, step] of steps.entries()) completeStep(fixture.store, blob.id, step, index < 2);

  const result = fixture.store.rewindBlob(blob.id, steps[1], steps);
  const receipts = fixture.store.listReceipts(blob.id);

  assert.equal(result.blob.state, "dev.workbench");
  assert.equal(result.blob.forcedStepId, "dev.workbench");
  assert.equal(receipts[0].invalidatedAt, null);
  assert.ok(receipts[1].invalidatedAt);
  assert.ok(receipts[2].invalidatedAt);
  assert.equal(fixture.store.rewindBlob(blob.id, steps[1], steps).already, true);
  fixture.database.close();
});

test("rewind follows current stable-ID order after steps are renumbered", () => {
  const fixture = createStoreFixture(["plan.define", "dev.workbench", "qa.check"]);
  const blob = fixture.store.createBlob("blob-1", blobInput(fixture)).blob;
  const original = discoverPipeline(fixture.pipelinePath);
  for (const [index, step] of original.entries()) completeStep(fixture.store, blob.id, step, index < 2);
  renumberStep(fixture.pipelinePath, 0, 20, "plan.define");
  renumberStep(fixture.pipelinePath, 1, 0, "dev.workbench");
  renumberStep(fixture.pipelinePath, 2, 10, "qa.check");
  commitAll(fixture.root, "reorder");
  const current = discoverPipeline(fixture.pipelinePath);

  fixture.store.rewindBlob(blob.id, current[1], current);

  const validity = Object.fromEntries(
    fixture.store.listReceipts(blob.id).map((receipt) => [receipt.stepId, !receipt.invalidatedAt]),
  );
  assert.deepEqual(validity, { "plan.define": false, "dev.workbench": true, "qa.check": false });
  fixture.database.close();
});

test("stale lease owners cannot write receipts", () => {
  let now = "2026-07-19T00:00:00.000Z";
  const fixture = createStoreFixture(["plan.define"], () => now);
  const blob = fixture.store.createBlob("blob-1", blobInput(fixture)).blob;
  fixture.store.requestContinuous(blob.id);
  const step = discoverPipeline(fixture.pipelinePath)[0];
  assert.equal(fixture.store.acquireLease("first", 1_000), true);
  const claim = fixture.store.beginReceipt({
    blobId: blob.id,
    step,
    definition: snapshotDefinition(step, fixture.pipelinePath),
    adapter: "fake",
    inputArtifacts: [],
  }, "first");

  now = "2026-07-19T00:00:02.000Z";
  assert.equal(fixture.store.acquireLease("second", 1_000), true);
  assert.throws(
    () => fixture.store.recordExternalRun(claim.receipt.id, "run-1", "first"),
    /lease was lost/,
  );
  fixture.database.close();
});

function completeStep(
  store: ConveyorStore,
  blobId: string,
  step: StepDefinition,
  hasNext: boolean,
): void {
  const blob = store.getBlob(blobId)!;
  if (!blob.runRequested) store.requestContinuous(blobId);
  const definition = snapshotDefinition(step, blob.pipelinePath);
  const claim = store.beginReceipt({ blobId, step, definition, adapter: "fake", inputArtifacts: [] });
  store.completeReceipt(claim.receipt.id, {
    status: "advance",
    reason: "done",
    outputArtifacts: [`artifact:${step.id}`],
    externalRunId: null,
  }, hasNext ? nextStepId(blob.pipelinePath, step) : null);
}

function nextStepId(pipelinePath: string, step: StepDefinition): string | null {
  const steps = discoverPipeline(pipelinePath);
  return steps[steps.findIndex((candidate) => candidate.id === step.id) + 1]?.id ?? null;
}

function createStoreFixture(
  steps = ["plan.define"],
  now?: () => string,
): StoreFixture {
  const pipeline = createPipeline(steps);
  const database = new FactorioDatabase(join(pipeline.root, "factorio.sqlite"));
  return { ...pipeline, database, store: new ConveyorStore(database, now) };
}

function blobInput(fixture: PipelineFixture): BlobInput {
  return {
    title: "Test blob",
    body: "Do the thing",
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

type StoreFixture = PipelineFixture & {
  database: FactorioDatabase;
  store: ConveyorStore;
};

import type { StepDefinition, BlobInput } from "../src/Types.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { commitAll, createPipeline } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { discoverPipeline, snapshotDefinition } from "../src/Pipeline.ts";
import { ConveyorStore } from "../src/Store.ts";
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
