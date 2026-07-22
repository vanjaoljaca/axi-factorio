export async function runArtifactConveyorScenario(): Promise<ArtifactConveyorScenario> {
  const fixture = createPipeline(["plan.first", "build.next"]);
  const artifact = join(fixture.root, "artifacts", "plan.md");
  writeFileSync(join(fixture.pipelinePath, "0.plan.first.exit.md"), "[Plan artifact](artifacts/plan.md)");
  commitAll(fixture.root, "declare artifact");
  const database = new FactorioDatabase(join(fixture.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  const steps = discoverPipeline(fixture.pipelinePath);
  store.createBlob(blobId, {
    title: "Explore authored content", body: "Produce a durable plan artifact.",
    cwd: fixture.root, executionWorkspaceRoot: fixture.root,
    pipelinePath: fixture.pipelinePath, inputArtifacts: [],
  });
  store.requestContinuous(blobId);
  const claim = store.beginReceipt({
    blobId, step: steps[0], definition: snapshotDefinition(steps[0], fixture.pipelinePath),
    adapter: "scenario-agent", inputArtifacts: [],
  });
  const frames = [frame("Fan-out task running", "The agent task owns the current pip; no classifier result exists.", store, artifact)];
  mkdirSync(dirname(artifact));
  writeFileSync(artifact, "durable plan");
  store.failReceipt(claim.receipt.id, "Legacy classifier became unavailable after artifact creation.");
  frames.push(frame("Artifact survives evaluator loss", "The product artifact is visible even though the old evaluator failed.", store, artifact));
  store.retryBlob(blobId, true);
  await new ConveyorRunner(store, new ArtifactPresenceHarness()).runBlob(blobId);
  frames.push(frame("Artifact fans in to next pip", "Deterministic presence verification advances once; no classifier or agent rerun.", store, artifact));
  const receipts = store.listReceipts(blobId);
  database.close();
  return { id: scenarioId, frames, receipts, artifact };
}

function frame(
  name: string,
  description: string,
  store: ConveyorStore,
  artifact: string,
): ArtifactConveyorFrame {
  const blob = store.getBlob(blobId)!;
  const receipts = store.listReceipts(blobId);
  return {
    name, description, source: "scenario",
    steps: [viewStep("plan.first"), viewStep("build.next")],
    blobs: [{ id: blob.id, title: blob.title, state: blob.state, stepId: blob.state }],
    receipts: receipts.map((receipt) => ({
      id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId,
      status: receipt.status, at: receipt.finishedAt ?? receipt.startedAt,
      detail: receipt.reason ?? receipt.error ?? receipt.currentOperation ?? "running",
    })),
    assertions: assertions(blob, receipts, artifact),
    evidenceCards: [
      { label: "Declared by ordinary Markdown", value: "[Plan artifact](artifacts/plan.md)" },
      { label: "Artifact", value: `${existsSync(artifact) ? "present" : "missing"} · ${artifact}` },
      { label: "Conveyor state", value: `${blob.state} · ${blob.runRequested ? "running" : "stopped"}` },
    ],
  };
}

function assertions(blob: Blob, receipts: Receipt[], artifact: string): Assertion[] {
  const verified = receipts.some((receipt) => receipt.adapter === "artifact-presence" && receipt.status === "advance");
  return [
    { label: "Declared artifact exists", passed: existsSync(artifact) },
    { label: "Legacy failed receipt stays append-only", passed: receipts.at(0)?.status === "failed" },
    { label: "Artifact verification used no agent", passed: !verified || receipts.at(-1)?.externalRunId === null },
    { label: "Exactly one pip advanced", passed: !verified || blob.state === "build.next" },
  ];
}

function viewStep(id: string): { id: string; label: string } {
  return { id, label: id.split(".").at(-1) ?? id };
}

export type ArtifactConveyorScenario = {
  id: string;
  frames: ArtifactConveyorFrame[];
  receipts: Receipt[];
  artifact: string;
};

type ArtifactConveyorFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: Array<{ id: string; blobId: string; stepId: string; status: string; at: string; detail: string }>;
  assertions: Assertion[];
  evidenceCards: Array<{ label: string; value: string }>;
};

type Assertion = { label: string; passed: boolean };

const scenarioId = "artifact-conveyor";
const blobId = "artifact-conveyor-blob";

import type { Blob, Receipt } from "../../src/Types.ts";
import { ArtifactPresenceHarness } from "../../src/ArtifactPresenceHarness.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { discoverPipeline, snapshotDefinition } from "../../src/Pipeline.ts";
import { ConveyorRunner } from "../../src/Runner.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { commitAll, createPipeline } from "../../tests/Fixtures.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
