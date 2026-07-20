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

test("production learning API preserves revisions, prompt provenance, reruns, and restart history", async () => {
  const fixture = createPipeline(["build.first", "review.second"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  let database = new FactorioDatabase(databasePath);
  let store = new ConveyorStore(database);
  store.createBlob("learning", {
    title: "Learning item", body: "First request", cwd: fixture.root,
    pipelinePath: fixture.pipelinePath, inputArtifacts: ["request:test"],
  });
  store.requestStep("learning");
  await new ConveyorService(store, new ConveyorRunner(store, new MockAgentHarness())).runOnce(
    new AbortController().signal,
  );
  database.close();
  let server = createViewerServer(databasePath);
  let endpoint = await listen(server);

  const first = await fetch(`${endpoint}/api/blobs/learning/learning`).then(readJson);
  assert.equal(first.attempts.length, 1);
  assert.equal(first.attempts[0].evidence.blobRevision.revision, 1);
  assert.equal(first.attempts[0].evidence.definition.entry, "entry:build.first");
  assert.equal(first.attempts[0].inputTokens, 40);
  assert.equal(first.attempts[0].outputTokens, 20);

  const blobPreview = await postJson(endpoint, "learning", "blob/preview", {
    title: "Learning item", body: "Improved request",
  });
  assert.equal(blobPreview.valid, true);
  await postJson(endpoint, "learning", "blob/save", {
    title: "Learning item", body: "Improved request", expectedRevision: 1,
  });
  const promptPreview = await postJson(endpoint, "learning", "prompt/preview", {
    stepId: "build.first", kind: "entry", content: "entry:build.first\nimproved",
  });
  assert.equal(promptPreview.valid, true);
  await postJson(endpoint, "learning", "prompt/save", {
    stepId: "build.first", kind: "entry", content: "entry:build.first\nimproved",
    expectedContentHash: promptPreview.expectedContentHash,
  });
  await postJson(endpoint, "learning", "rewind-step", { stepId: "build.first" });
  await close(server);

  database = new FactorioDatabase(databasePath);
  store = new ConveyorStore(database);
  await new ConveyorService(store, new ConveyorRunner(store, new MockAgentHarness())).runOnce(
    new AbortController().signal,
  );
  database.close();
  server = createViewerServer(databasePath);
  endpoint = await listen(server);
  const restarted = await fetch(`${endpoint}/api/blobs/learning/learning`).then(readJson);
  await close(server);

  assert.equal(restarted.revision.revision, 2);
  assert.equal(restarted.attempts.length, 2);
  assert.ok(restarted.attempts[0].receipt.invalidatedAt);
  assert.equal(restarted.attempts[0].evidence.blobRevision.body, "First request");
  assert.equal(restarted.attempts[1].evidence.blobRevision.body, "Improved request");
  assert.notEqual(
    restarted.attempts[0].evidence.definition.contentHash,
    restarted.attempts[1].evidence.definition.contentHash,
  );
});

test("production learning API rejects invalid and stale prompt edits without writing", async () => {
  const fixture = createPipeline(["build.first"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createBlob("safe-edit", blobInput(fixture, "Safe edit"));
  database.close();
  const server = createViewerServer(databasePath);
  const endpoint = await listen(server);

  const invalid = await postJson(endpoint, "safe-edit", "prompt/preview", {
    stepId: "build.first", kind: "entry", content: "",
  });
  assert.equal(invalid.valid, false);
  const response = await fetch(`${endpoint}/api/blobs/safe-edit/prompt/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stepId: "build.first", kind: "entry", content: "changed", expectedContentHash: "stale",
    }),
  });
  await close(server);

  assert.equal(response.status, 500);
  assert.equal(readFileSync(discoverPipeline(fixture.pipelinePath)[0].entryPath, "utf8"), "entry:build.first");
});

async function readJson(response: Response): Promise<any> {
  assert.equal(response.status, 200);
  return response.json();
}

async function postJson(
  endpoint: string,
  blobId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(`${endpoint}/api/blobs/${blobId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(`Expected 200, received ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function listen(server: ReturnType<typeof createViewerServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Viewer did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createViewerServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
import { ConveyorRunner } from "../src/Runner.ts";
import { ConveyorService } from "../src/Service.ts";
import { MockAgentHarness } from "../test/harness/MockHarness.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
