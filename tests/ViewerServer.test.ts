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

type ViewSnapshot = {
  stats: { projects: number; tasks: number };
  projects: Array<{
    root: string;
    pipelineRoot: string;
    resolvedPipeline: string | null;
    steps: Array<{ id: string }>;
  }>;
};

import { createPipeline } from "./Fixtures.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorStore } from "../src/Store.ts";
import { createViewSnapshot } from "../src/ViewerServer.ts";
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
