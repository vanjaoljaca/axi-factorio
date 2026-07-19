export class FactorioDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.configure();
    this.connection.exec(schema);
  }

  close(): void {
    this.connection.close();
  }

  transaction<T>(work: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.connection.exec("COMMIT");
      return value;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  private configure(): void {
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
  }
}

const schema = `
  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pipelinePath TEXT NOT NULL,
    inputArtifactsJson TEXT NOT NULL,
    state TEXT NOT NULL,
    lastCompletedStepId TEXT,
    lastCompletedOrder INTEGER,
    forcedStepId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS blobsRunnable ON blobs(state, updatedAt, createdAt);

  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    blobId TEXT NOT NULL REFERENCES blobs(id),
    stepId TEXT NOT NULL,
    stepOrder INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    adapter TEXT NOT NULL,
    definitionGitSha TEXT NOT NULL,
    definitionHash TEXT NOT NULL,
    inputArtifactsJson TEXT NOT NULL,
    outputArtifactsJson TEXT NOT NULL,
    externalRunId TEXT,
    reason TEXT,
    error TEXT,
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    invalidatedAt TEXT,
    UNIQUE(blobId, stepId, attempt)
  );

  CREATE INDEX IF NOT EXISTS receiptsByBlob ON receipts(blobId, startedAt, stepOrder);

  CREATE TABLE IF NOT EXISTS dispatcherLeases (
    name TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    leaseUntil TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`;

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
