export function runViewerResilienceScenario(): Scenario {
  const fixture = createPipeline(["g1.first", "g2.second"]);
  const pipelineRoot = join(fixture.root, "pipelines");
  const versionPath = join(pipelineRoot, "default", "v1");
  mkdirSync(dirname(versionPath), { recursive: true });
  renameSync(fixture.pipelinePath, versionPath);
  const databasePath = join(fixture.root, "factorio.sqlite");
  const database = new FactorioDatabase(databasePath);
  const store = new ConveyorStore(database);
  store.createProject("healthy", {
    name: "Healthy project", root: fixture.root, pipelineRoot, defaultPipeline: "default",
  });
  store.createBlob("healthy-task", {
    title: "Healthy task stays visible", body: "", cwd: fixture.root, projectId: "healthy",
    pipelineId: "default/v1", pipelinePath: versionPath, inputArtifacts: [],
  });
  const before = frame(createViewSnapshot(databasePath) as ViewerSnapshot, "Healthy Viewer");
  store.createProject("stale-disposable", {
    name: "Stale disposable proof", root: fixture.root,
    pipelineRoot: join(fixture.root, "missing"), defaultPipeline: "pipeline",
  });
  database.close();
  const after = frame(createViewSnapshot(databasePath) as ViewerSnapshot, "Failure isolated");
  return { id: "viewer-resilience", frames: [before, after] };
}

function frame(snapshot: ViewerSnapshot, name: string): WorkbenchFrame {
  const stale = snapshot.projects.find((project) => project.id === "stale-disposable");
  const healthy = snapshot.projects.find((project) => project.id === "healthy");
  return {
    name,
    description: stale
      ? "Missing disposable pipeline is diagnosed; healthy Viewer content remains usable."
      : "A healthy project is rendered before the disposable pipeline disappears.",
    source: "scenario",
    steps: snapshot.steps,
    blobs: healthy?.blobs.map((blob) => ({
      id: blob.id, title: blob.title, state: blob.status, stepId: blob.stepId,
    })) ?? [],
    receipts: [],
    assertions: [
      { label: "Healthy project remains visible", passed: healthy?.blobs[0]?.id === "healthy-task" },
      { label: "Viewer snapshot remains available", passed: snapshot.stats.projects >= 1 },
      ...(stale ? [{
        label: "Missing pipeline is isolated and explicitly diagnosed",
        passed: stale.pipelineIssue?.status === "unavailable",
      }] : []),
    ],
    evidenceCards: [
      { label: "Healthy project", value: `${healthy?.name ?? "missing"}\nPipeline ${healthy?.resolvedPipeline ?? "unavailable"}` },
      ...(stale ? [{
        label: "Visible project diagnosis",
        value: `${stale.name}\n${stale.pipelineIssue?.summary}\n${stale.pipelineIssue?.detail}`,
      }] : []),
      { label: "Dispatcher ownership", value: "Named launchd service owns one dispatcher; a prior lease is waited out." },
    ],
  };
}

type ViewerSnapshot = {
  stats: { projects: number };
  steps: Array<{ id: string; label: string }>;
  projects: Array<{
    id: string;
    name: string;
    resolvedPipeline: string | null;
    pipelineIssue: { status: string; summary: string; detail: string } | null;
    blobs: Array<{ id: string; title: string; status: string; stepId: string }>;
  }>;
};
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: [];
  assertions: Array<{ label: string; passed: boolean }>;
  evidenceCards: Array<{ label: string; value: string }>;
};
type Scenario = { id: string; frames: WorkbenchFrame[] };

import { FactorioDatabase } from "../../src/Database.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { createViewSnapshot } from "../../src/ViewerServer.ts";
import { createPipeline } from "../../tests/Fixtures.ts";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
