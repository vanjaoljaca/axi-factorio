test("zero-blob projects share one pipeline root and expose resolved identities", () => {
  const fixture = createPipeline(["g1.first", "g2.second"]);
  const pipelineRoot = join(fixture.root, "shared-pipelines");
  const versionPath = join(pipelineRoot, "default", "v1");
  mkdirSync(dirname(versionPath), { recursive: true });
  renameSync(fixture.pipelinePath, versionPath);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  const firstRoot = join(fixture.root, "apps", "first");
  const secondRoot = join(fixture.root, "apps", "second");
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  store.createProject("first", {
    name: "First", root: firstRoot, pipelineRoot, defaultPipeline: "default",
  });
  store.createProject("second", {
    name: "Second", root: secondRoot, pipelineRoot, defaultPipeline: "default",
  });
  database.close();

  const snapshot = createViewSnapshot(databasePath) as ViewSnapshot;

  assert.equal(snapshot.stats.projects, 2);
  assert.equal(snapshot.stats.tasks, 0);
  assert.deepEqual(snapshot.projects.map((project) => project.root), [firstRoot, secondRoot]);
  assert.deepEqual(snapshot.projects.map((project) => project.pipelineRoot), [pipelineRoot, pipelineRoot]);
  assert.deepEqual(snapshot.projects.map((project) => project.resolvedPipeline), ["default/v1", "default/v1"]);
  assert.deepEqual(snapshot.projects[0].steps.map((step) => step.id), ["g1.first", "g2.second"]);
});

test("viewer distinguishes imported work awaiting review from failed work", () => {
  const fixture = createPipeline(["g1.first", "g2.review", "g3.last"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  const steps = discoverPipeline(fixture.pipelinePath);
  const imported = store.createBlob("imported", blobInput(fixture, "Imported work")).blob;
  store.adoptBlob(imported.id, steps[1], steps, "git-sha:abc123", [{
    step: steps[0],
    definition: snapshotDefinition(steps[0], fixture.pipelinePath),
    evidence: ["test:passed"],
  }]);
  database.connection.prepare("UPDATE blobs SET paused = 1 WHERE id = ?").run(imported.id);
  const failed = store.createBlob("failed", blobInput(fixture, "Failed work")).blob;
  store.requestContinuous(failed.id);
  const failure = store.beginReceipt({
    blobId: failed.id, step: steps[0],
    definition: snapshotDefinition(steps[0], fixture.pipelinePath),
    adapter: "fake", inputArtifacts: [],
  });
  store.failReceipt(failure.receipt.id, "broken");
  database.close();

  const snapshot = createViewSnapshot(databasePath) as ViewSnapshot;
  const blobs = snapshot.projects.flatMap((project) => project.blobs);

  assert.deepEqual(selectState(blobs, "imported"), {
    id: "imported", status: "waiting", importedStepIds: ["g1.first"],
  });
  assert.deepEqual(selectState(blobs, "failed"), {
    id: "failed", status: "failed", importedStepIds: [],
  });
});

test("viewer keeps paused zero-receipt inventory neutral", () => {
  const fixture = createPipeline(["g1.first", "g2.second"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  const inventory = store.createBlob("inventory", blobInput(fixture, "Inventory item")).blob;
  database.connection.prepare("UPDATE blobs SET paused = 1 WHERE id = ?").run(inventory.id);
  database.close();

  const snapshot = createViewSnapshot(databasePath) as ViewSnapshot;
  const blobs = snapshot.projects.flatMap((project) => project.blobs);

  assert.deepEqual(selectState(blobs, "inventory"), {
    id: "inventory", status: "held", importedStepIds: [],
  });
  const control = blobs.find((blob) => blob.id === "inventory")?.execution.play;
  assert.deepEqual(control, {
    enabled: false,
    explanation: "Inventory is held. Retry it before running.",
  });
});

test("viewer execution API persists Play, Step, and Stop without duplicate requests", async () => {
  const fixture = createPipeline(["g1.first", "g2.second"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createBlob("controlled", blobInput(fixture, "Controlled item"));
  database.close();
  const server = createViewerServer(databasePath);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Viewer did not bind a TCP port.");
  const endpoint = `http://127.0.0.1:${address.port}`;

  const played = await fetch(`${endpoint}/api/blobs/controlled/play`, { method: "POST" }).then(readJson);
  const replayed = await fetch(`${endpoint}/api/blobs/controlled/play`, { method: "POST" }).then(readJson);
  const stopped = await fetch(`${endpoint}/api/blobs/controlled/stop`, { method: "POST" }).then(readJson);
  const stepped = await fetch(`${endpoint}/api/blobs/controlled/step`, { method: "POST" }).then(readJson);
  server.close();

  assert.equal(played.already, false);
  assert.equal(replayed.already, true);
  assert.equal(stopped.blob.runRequested, false);
  assert.equal(stepped.blob.executionMode, "step");
  assert.equal(stepped.blob.runRequested, true);
});

async function readJson(response: Response): Promise<any> {
  assert.equal(response.status, 200);
  return response.json();
}

function selectState(
  blobs: Array<{ id: string; status: string; importedStepIds: string[] }>,
  id: string,
): { id: string; status: string; importedStepIds: string[] } | undefined {
  const blob = blobs.find((candidate) => candidate.id === id);
  return blob && { id: blob.id, status: blob.status, importedStepIds: blob.importedStepIds };
}

function blobInput(fixture: PipelineFixture, title: string): BlobInput {
  return {
    title, body: "", cwd: fixture.root, pipelinePath: fixture.pipelinePath, inputArtifacts: [],
  };
}

type ViewSnapshot = {
  stats: { projects: number; tasks: number };
  projects: Array<{
    root: string;
    pipelineRoot: string;
    resolvedPipeline: string | null;
    steps: Array<{ id: string }>;
    blobs: Array<{
      id: string;
      status: string;
      importedStepIds: string[];
      execution: { play: { enabled: boolean; explanation: string } };
    }>;
  }>;
};

import type { BlobInput } from "../src/Types.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { createPipeline } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorStore } from "../src/Store.ts";
import { createViewerServer, createViewSnapshot } from "../src/ViewerServer.ts";
import { discoverPipeline, snapshotDefinition } from "../src/Pipeline.ts";
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
