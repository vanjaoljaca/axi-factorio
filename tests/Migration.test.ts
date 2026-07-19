test("rc.4 project cwd migrates to distinct project and pipeline roots", () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-migration-"));
  const path = join(root, "factorio.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(legacySchema);
  legacy.prepare(`INSERT INTO projects
    (id, name, cwd, defaultPipeline, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    "app", "App", join(root, "apps", "app"), "default", now, now,
  );
  legacy.close();

  const database = new FactorioDatabase(path);
  const project = new ConveyorStore(database).getProject("app");

  assert.equal(project?.root, join(root, "apps", "app"));
  assert.equal(project?.pipelineRoot, join(root, "apps", "app", "pipelines"));
  assert.equal(project?.defaultPipeline, "default");
  database.close();
});

const now = "2026-07-19T00:00:00.000Z";
const legacySchema = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
    defaultPipeline TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE blobs (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL, body TEXT NOT NULL, cwd TEXT NOT NULL, pipelineId TEXT NOT NULL,
    pipelinePath TEXT NOT NULL, inputArtifactsJson TEXT NOT NULL, state TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0, lastCompletedStepId TEXT, lastCompletedOrder INTEGER,
    forcedStepId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE receipts (
    id TEXT PRIMARY KEY, blobId TEXT NOT NULL REFERENCES blobs(id), stepId TEXT NOT NULL,
    stepOrder INTEGER NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
    adapter TEXT NOT NULL, definitionGitSha TEXT NOT NULL, definitionHash TEXT NOT NULL,
    inputArtifactsJson TEXT NOT NULL, outputArtifactsJson TEXT NOT NULL, externalRunId TEXT,
    reason TEXT, error TEXT, startedAt TEXT NOT NULL, finishedAt TEXT, invalidatedAt TEXT,
    UNIQUE(blobId, stepId, attempt)
  );
  CREATE TABLE dispatcherLeases (
    name TEXT PRIMARY KEY, ownerId TEXT NOT NULL, leaseUntil TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
`;

import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorStore } from "../src/Store.ts";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
