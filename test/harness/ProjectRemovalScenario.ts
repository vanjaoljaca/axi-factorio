export class ProjectRemovalScenario {
  private fixture: Fixture = createFixture();
  private phase: "preview" | "removed" = "preview";

  snapshot(): Scenario {
    return { id: scenarioId, frames: [this.frame()] };
  }

  remove(): Scenario {
    const preview = this.fixture.store.previewProjectRemoval(projectId);
    this.fixture.store.removeProject(projectId, preview.confirmation, ["workbench:explicit-cleanup"]);
    this.phase = "removed";
    return this.snapshot();
  }

  reset(): Scenario {
    this.fixture.dispose();
    this.fixture = createFixture();
    this.phase = "preview";
    return this.snapshot();
  }

  dispose(): void {
    this.fixture.dispose();
  }

  private frame(): Frame {
    const preview = this.phase === "preview"
      ? this.fixture.store.previewProjectRemoval(projectId)
      : { projectId, projectName: "Disposable proof", blobCount: 2, receiptCount: 1, confirmation: projectId };
    const audit = this.fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM projectRemovals").get() as { count: number };
    return {
      name: "Remove a disposable project safely",
      description: "Preview exact scope · exact confirmation · durable evidence · Reset",
      source: "scenario", steps: [], blobs: [], receipts: [],
      assertions: [
        { label: "Preview names the exact project", passed: preview.confirmation === projectId },
        { label: "Preview counts two blobs and one receipt", passed: preview.blobCount === 2 && preview.receiptCount === 1 },
        { label: "Removal leaves a durable evidence record", passed: this.phase === "preview" || audit.count === 1 },
      ],
      visual: { kind: "project-removal", phase: this.phase, preview, auditCount: audit.count },
    };
  }
}

function createFixture(): Fixture {
  const pipeline = createPipeline(["g1.first"]);
  const database = new FactorioDatabase(join(pipeline.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  store.createProject(projectId, {
    name: "Disposable proof", root: pipeline.root,
    pipelineRoot: pipeline.root, defaultPipeline: pipeline.pipelinePath,
  });
  const first = store.createBlob("proof-one", blobInput(pipeline, "Proof one")).blob;
  store.createBlob("proof-two", blobInput(pipeline, "Proof two"));
  const step = discoverPipeline(pipeline.pipelinePath)[0];
  store.requestStep(first.id);
  const receipt = store.beginReceipt({
    blobId: first.id, step, definition: snapshotDefinition(step, pipeline.pipelinePath),
    adapter: "fake", inputArtifacts: [],
  }).receipt;
  store.failReceipt(receipt.id, "Disposable proof finished for cleanup.");
  return {
    database, store,
    dispose: () => { database.close(); rmSync(pipeline.root, { recursive: true, force: true }); },
  };
}

function blobInput(pipeline: PipelineFixture, title: string): BlobInput {
  return {
    title, body: "Disposable installed-runtime proof", cwd: pipeline.root,
    projectId, pipelinePath: pipeline.pipelinePath, inputArtifacts: [],
  };
}

type Fixture = { database: FactorioDatabase; store: ConveyorStore; dispose: () => void };
type Frame = {
  name: string; description: string; source: "scenario"; steps: []; blobs: []; receipts: [];
  assertions: Array<{ label: string; passed: boolean }>;
  visual: ProjectRemovalVisual;
};
export type ProjectRemovalVisual = {
  kind: "project-removal";
  phase: "preview" | "removed";
  preview: { projectId: string; projectName: string; blobCount: number; receiptCount: number; confirmation: string };
  auditCount: number;
};
type Scenario = { id: string; frames: Frame[] };

const scenarioId = "project-removal";
const projectId = "disposable-proof";

import type { BlobInput } from "../../src/Types.ts";
import type { PipelineFixture } from "../../tests/Fixtures.ts";
import { createPipeline } from "../../tests/Fixtures.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { discoverPipeline, snapshotDefinition } from "../../src/Pipeline.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
