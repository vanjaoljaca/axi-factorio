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

test("viewer isolates and diagnoses one missing project pipeline without hiding healthy projects", () => {
  const fixture = createPipeline(["g1.first"]);
  const pipelineRoot = join(fixture.root, "pipelines");
  const versionPath = join(pipelineRoot, "default", "v1");
  mkdirSync(dirname(versionPath), { recursive: true });
  renameSync(fixture.pipelinePath, versionPath);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createProject("healthy", {
    name: "Healthy", root: fixture.root, pipelineRoot, defaultPipeline: "default",
  });
  store.createProject("stale-proof", {
    name: "Stale proof", root: fixture.root,
    pipelineRoot: join(fixture.root, "missing"), defaultPipeline: "disposable",
  });
  store.createBlob("healthy-blob", {
    title: "Healthy task", body: "", cwd: fixture.root, projectId: "healthy",
    pipelineId: "default/v1", pipelinePath: versionPath, inputArtifacts: [],
  });
  database.close();

  const snapshot = createViewSnapshot(databasePath) as ViewSnapshot;
  const healthy = snapshot.projects.find((project) => project.id === "healthy");
  const stale = snapshot.projects.find((project) => project.id === "stale-proof");

  assert.equal(healthy?.blobs[0]?.id, "healthy-blob");
  assert.equal(healthy?.pipelineIssue, null);
  assert.equal(stale?.pipelineIssue?.status, "unavailable");
  assert.equal(stale?.pipelineIssue?.summary, "Pipeline unavailable");
  assert.match(stale?.pipelineIssue?.detail ?? "", /ENOENT|no vN versions/u);
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

test("viewer exposes the effective execution workspace through the shared Cursor action", () => {
  const fixture = createPipeline(["g1.first"]);
  const assignedRoot = join(fixture.root, "assigned workspace --literal");
  const appRoot = join(assignedRoot, "apps", "example");
  mkdirSync(appRoot, { recursive: true });
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createBlob("assigned", { ...blobInput(fixture, "Assigned workspace"), cwd: appRoot });
  store.bindExecutionWorkspace("assigned", assignedRoot, ["test:assigned"]);
  store.createBlob("project", blobInput(fixture, "Project root"));
  store.createBlob("stale", blobInput(fixture, "Stale workspace"));
  database.connection.prepare("UPDATE blobs SET executionWorkspaceRoot = ? WHERE id = ?")
    .run(join(fixture.root, "missing"), "stale");
  database.close();
  const expectedAssignedRoot = realpathSync(assignedRoot);
  const launcher = new CursorWorkspaceLauncher("/fake/cursor", async () => undefined, (path) => path !== join(fixture.root, "missing"));

  const snapshot = createViewSnapshot(databasePath, launcher) as ViewSnapshot;
  const blobs = snapshot.projects.flatMap((project) => project.blobs);

  assert.deepEqual(blobs.find((blob) => blob.id === "assigned")?.open, {
    enabled: true, root: expectedAssignedRoot, workspaceKind: "assigned-workspace",
    label: "Open in Cursor", explanation: "Open the assigned execution workspace in Cursor.",
  });
  assert.equal(blobs.find((blob) => blob.id === "project")?.open.workspaceKind, "project-root");
  assert.equal(blobs.find((blob) => blob.id === "stale")?.open.enabled, false);
});

test("viewer exposes persisted running and completed execution telemetry", async () => {
  const fixture = createPipeline(["g1.first", "g2.second"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createBlob("telemetry", blobInput(fixture, "Telemetry item"));
  store.requestStep("telemetry");
  await new ConveyorRunner(store, new MockAgentHarness()).runOnce();

  const snapshot = createViewSnapshot(databasePath) as ViewSnapshot;
  const execution = snapshot.executionSessions[0];

  assert.equal(execution.blobId, "telemetry");
  assert.equal(execution.status, "advance");
  assert.equal(execution.model, "deterministic-v1");
  assert.equal(execution.reasoningEffort, "low");
  assert.equal(execution.cachedInputTokens, 12);
  assert.equal(execution.totalTokens, 60);
  assert.equal(execution.finishedAt !== null, true);
  assert.equal(execution.lastProgressAt >= execution.startedAt, true);
  assert.match(snapshot.executionOverviewHtml, /Execution sessions/u);
  assert.match(snapshot.executionOverviewHtml, /Advanced/u);
  database.close();
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

test("Viewer Debug setting is durable, manual, and exposed through Settings", async () => {
  const fixture = createPipeline(["g1.first", "g2.second"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createBlob("debug-controlled", blobInput(fixture, "Debug controlled item"));
  store.requestContinuous("debug-controlled");
  database.close();
  const server = createViewerServer(databasePath);
  const endpoint = await listen(server);
  try {
    const enabled = await fetch(`${endpoint}/api/settings/debug-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }).then(readJson);
    const snapshot = await fetch(`${endpoint}/api/view`).then(readJson) as ViewSnapshot;
    const opener = await fetch(`${endpoint}/api/settings/opener`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opener: "cursor" }),
    }).then(readJson);
    const view = await fetch(`${endpoint}/api/settings/view`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ activeProjectDays: 3, sortProjectsByProgress: false }),
    }).then(readJson);
    const play = await fetch(`${endpoint}/api/blobs/debug-controlled/play`, { method: "POST" });

    assert.equal(enabled.settings.debugMode, true);
    assert.equal(snapshot.settings.debugMode, true);
    assert.deepEqual(opener.settings.opener, { id: "cursor", label: "Cursor" });
    assert.deepEqual(view.settings, { activeProjectDays: 3, sortProjectsByProgress: false });
    assert.equal(snapshot.projects[0].blobs[0].execution.play.enabled, false);
    assert.equal(play.status, 409);
  } finally {
    await close(server);
  }
});

test("Viewer ships clickable Overview, Projects, Runs, Alerts, and Settings pages", async () => {
  const fixture = createPipeline(["g1.first"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  new FactorioDatabase(databasePath).close();
  const server = createViewerServer(databasePath);
  const endpoint = await listen(server);
  try {
    const body = await fetch(endpoint).then((response) => response.text());
    for (const page of ["overview", "projects", "runs", "alerts", "settings"]) {
      assert.match(body, new RegExp(`data-page="${page}"`, "u"));
    }
    assert.match(body, /id="debug-mode"/u);
    assert.match(body, /if\(!snapshot\.settings\.debugMode\)return ''/u);
    assert.match(body, /aggregateCell/u);
    assert.match(body, /collapsedProjects/u);
    assert.match(body, /collapseNewProjects\(next\.projects\)/u);
    assert.match(body, /collapsed\?'‹':'⌄'/u);
    assert.match(body, /data-project-toggle/u);
    assert.doesNotMatch(body, /Project progress|data-action="open-cursor"/u);
    assert.match(body, /id="blob-menu"/u);
    assert.match(body, /Default opener/u);
    assert.match(body, />Cursor</u);
    assert.match(body, /held:''/u);
    assert.match(body, /Inventory — held before its first run\./u);
  } finally {
    await close(server);
  }
});

test("Overview starts with projects and never mounts execution-session diagnostics", async () => {
  const fixture = createPipeline(["g1.first"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  new FactorioDatabase(databasePath).close();
  const server = createViewerServer(databasePath);
  const endpoint = await listen(server);
  try {
    const body = await fetch(endpoint).then((response) => response.text());
    assert.doesNotMatch(body, /id="execution-overview"|Execution sessions|Working directory|Harness session/);
    assert.match(body, /id="workspace"/);
  } finally {
    await close(server);
  }
});

test("production Viewer source cannot import internal Workbench modules", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "ViewerServer.ts"), "utf8");
  assert.doesNotMatch(source, /WorkbenchServer|test\/harness|MockHarnessLab|LiveExecutionScenario/);
});

test("viewer configured Open API launches locally with the exact effective workspace argv", async () => {
  const fixture = createPipeline(["g1.first"]);
  const assignedRoot = join(fixture.root, "workspace with spaces --literal");
  const appRoot = join(assignedRoot, "apps", "example");
  mkdirSync(appRoot, { recursive: true });
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createBlob("cursor", { ...blobInput(fixture, "Cursor item"), cwd: appRoot });
  store.bindExecutionWorkspace("cursor", assignedRoot, ["test:assigned"]);
  database.close();
  const expectedAssignedRoot = realpathSync(assignedRoot);
  const calls: Array<{ executable: string; args: string[] }> = [];
  const launcher = new CursorWorkspaceLauncher("/fake/cursor", async (executable, args) => {
    calls.push({ executable, args });
  }, () => true);
  const server = createViewerServer(databasePath, launcher);
  const endpoint = await listen(server);

  const result = await postJson(endpoint, "cursor", "open", {});
  await close(server);

  assert.deepEqual(result, { blobId: "cursor", root: expectedAssignedRoot, opened: true });
  assert.deepEqual(calls, [{ executable: "/fake/cursor", args: [expectedAssignedRoot] }]);
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.0.2.12"), false);
});

test("viewer relocation API deliberately rebinds one blob and exposes durable provenance", async () => {
  const fixture = createPipeline(["g1.first"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createBlob("relocated", blobInput(fixture, "Relocated item"));
  database.close();
  const target = join(fixture.root, "workspace-b");
  mkdirSync(target);
  const server = createViewerServer(databasePath);
  const endpoint = await listen(server);

  const result = await postJson(endpoint, "relocated", "relocate", {
    root: target, evidence: ["api:explicit-rebind"],
  });
  const learning = await fetch(`${endpoint}/api/blobs/relocated/learning`).then(readJson);
  await close(server);

  assert.equal(result.blob.cwd, realpathSync(target));
  assert.equal(result.project.root, realpathSync(target));
  assert.equal(learning.workspaceRelocations.length, 1);
  assert.deepEqual(learning.workspaceRelocations[0].evidence, ["api:explicit-rebind"]);
});

test("viewer binds a containing execution workspace without moving the app project root", async () => {
  const fixture = createPipeline(["g1.first"]);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const worktree = join(fixture.root, "worktree");
  const appRoot = join(worktree, "apps", "example");
  mkdirSync(appRoot, { recursive: true });
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createBlob("bound", { ...blobInput(fixture, "Bound item"), cwd: appRoot });
  database.close();
  const server = createViewerServer(databasePath);
  const endpoint = await listen(server);

  const result = await postJson(endpoint, "bound", "execution-workspace", {
    root: worktree, evidence: ["api:worktree"],
  });
  const learning = await fetch(`${endpoint}/api/blobs/bound/learning`).then(readJson);
  await close(server);

  assert.equal(result.blob.cwd, appRoot);
  assert.equal(result.blob.executionWorkspaceRoot, realpathSync(worktree));
  assert.equal(learning.executionWorkspaceBindings.length, 1);
  assert.deepEqual(learning.executionWorkspaceBindings[0].evidence, ["api:worktree"]);
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
  settings: { debugMode: boolean; activeProjectDays: number; sortProjectsByProgress: boolean; opener: { id: string; label: string } };
  executionOverviewHtml: string;
  executionSessions: Array<{
    blobId: string;
    status: string;
    model: string | null;
    reasoningEffort: string | null;
    cachedInputTokens: number | null;
    totalTokens: number | null;
    startedAt: string;
    lastProgressAt: string;
    finishedAt: string | null;
  }>;
  projects: Array<{
    id: string;
    root: string;
    pipelineRoot: string;
    resolvedPipeline: string | null;
    pipelineIssue: { status: string; summary: string; detail: string } | null;
    steps: Array<{ id: string }>;
    blobs: Array<{
      id: string;
      status: string;
      importedStepIds: string[];
      execution: { play: { enabled: boolean; explanation: string } };
      open: {
        enabled: boolean;
        root: string;
        workspaceKind: "assigned-workspace" | "project-root";
        label: string;
        explanation: string;
      };
    }>;
  }>;
};

import type { BlobInput } from "../src/Types.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { createPipeline } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorStore } from "../src/Store.ts";
import { createViewerServer, createViewSnapshot, isLoopbackAddress } from "../src/ViewerServer.ts";
import { CursorWorkspaceLauncher } from "../src/CursorAction.ts";
import { discoverPipeline, snapshotDefinition } from "../src/Pipeline.ts";
import { ConveyorRunner } from "../src/Runner.ts";
import { ConveyorService } from "../src/Service.ts";
import { MockAgentHarness } from "../test/harness/MockHarness.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
