export function runActiveProjectsScenario(): Scenario {
  const databasePath = createFixture();
  const snapshot = createViewSnapshot(databasePath) as ViewerSnapshot;
  const active = snapshot.projects.filter(projectHasActiveWork);
  const inactive = snapshot.projects.filter((project) => !projectHasActiveWork(project));
  return { id: "active-projects-fold", frames: [{
    name: "Active projects fold",
    description: "Play refreshes, then reveal completed-only and empty projects without adding a second vertical scroller.",
    source: "scenario", steps: [], blobs: [], receipts: [],
    assertions: [
      { label: "Running and attention work is active", passed: active.some((project) => project.id === "running-app") },
      { label: "Paused review work is active", passed: active.some((project) => project.id === "review-app") },
      { label: "Inventory remains active", passed: active.some((project) => project.id === "inventory-app") },
      { label: "Completed-only and empty projects are inactive", passed: inactive.map((project) => project.id).join(",") === "completed-app,empty-app" },
    ], visual: { kind: "active-projects", active, inactive },
  }] };
}

function createFixture(): string {
  const fixture = createPipeline(["g1.plan", "g2.build", "g3.review", "g4.done"]);
  const pipelineRoot = join(fixture.root, "pipelines");
  const pipelinePath = join(pipelineRoot, "default", "v1");
  mkdirSync(dirname(pipelinePath), { recursive: true });
  renameSync(fixture.pipelinePath, pipelinePath);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  for (const [id, name] of projects) {
    const root = join(fixture.root, "apps", id);
    mkdirSync(root, { recursive: true });
    store.createProject(id, { name, root, pipelineRoot, defaultPipeline: "default" });
  }
  createActiveFixtures(store, pipelinePath, fixture.root);
  const complete = createBlob(store, "completed-app", "complete", "Finished task", pipelinePath, fixture.root);
  store.markCompleted(complete.id);
  database.close();
  return databasePath;
}

function createActiveFixtures(store: ConveyorStore, pipelinePath: string, root: string): void {
  const step = discoverPipeline(pipelinePath)[0];
  const running = createBlob(store, "running-app", "running", "Agent session running", pipelinePath, root);
  store.requestStep(running.id);
  store.beginReceipt({ blobId: running.id, step, definition: snapshotDefinition(step, pipelinePath), adapter: "fixture", inputArtifacts: [] });
  const review = createBlob(store, "review-app", "review", "Waiting for product review", pipelinePath, root);
  store.armHumanGate(review.id, "Review the result.");
  store.requestStep(review.id);
  const receipt = store.beginReceipt({ blobId: review.id, step, definition: snapshotDefinition(step, pipelinePath), adapter: "fixture", inputArtifacts: [] });
  store.completeReceipt(receipt.receipt.id, {
    status: "blocked", reason: "awaiting review", outputArtifacts: [], externalRunId: "fixture:review",
  }, discoverPipeline(pipelinePath)[1].id);
  for (let index = 0; index < 9; index += 1) createBlob(store, "inventory-app", `inventory-${index}`, `Inventory item ${index + 1}`, pipelinePath, root);
}

function createBlob(store: ConveyorStore, projectId: string, id: string, title: string, pipelinePath: string, root: string) {
  return store.createBlob(id, { title, body: "", cwd: join(root, "apps", projectId), projectId, pipelineId: "default/v1", pipelinePath, inputArtifacts: [] }).blob;
}

const projects = [
  ["running-app", "Running app"], ["review-app", "Review app"], ["inventory-app", "Inventory app"],
  ["completed-app", "Completed app"], ["empty-app", "Empty app"],
] as const;

type ScenarioProject = { id: string; name: string; blobs: Array<{ id: string; title: string; status: string; stepId: string; completedStepIds: string[] }> };
type ViewerSnapshot = { projects: ScenarioProject[] };
type Scenario = { id: string; frames: Array<Record<string, unknown>> };

import { FactorioDatabase } from "../../src/Database.ts";
import { discoverPipeline, snapshotDefinition } from "../../src/Pipeline.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { projectHasActiveWork } from "../../src/ViewerComponents.ts";
import { createViewSnapshot } from "../../src/ViewerServer.ts";
import { createPipeline } from "../../tests/Fixtures.ts";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
