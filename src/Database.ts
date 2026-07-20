export class FactorioDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.configure();
    this.connection.exec(schema);
    this.migrate();
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

  private migrate(): void {
    this.addProjectColumns();
    this.migrateBlobs();
    this.migrateProjects();
    this.migrateReceipts();
  }

  private addProjectColumns(): void {
    const columns = tableColumns(this.connection, "projects");
    addColumn(this.connection, columns, "root", "TEXT NOT NULL DEFAULT ''");
    addColumn(this.connection, columns, "pipelineRoot", "TEXT NOT NULL DEFAULT ''");
  }

  private migrateProjects(): void {
    const rows = this.connection.prepare("SELECT id, cwd, root, pipelineRoot FROM projects").all();
    for (const value of rows) this.migrateProject(value as ProjectMigrationRow);
  }

  private migrateProject(row: ProjectMigrationRow): void {
    const blob = this.connection.prepare("SELECT cwd FROM blobs WHERE projectId = ? LIMIT 1").get(row.id) as
      | { cwd?: string }
      | undefined;
    const root = row.root || row.cwd || blob?.cwd || process.cwd();
    const pipelineRoot = row.pipelineRoot || join(root, "pipelines");
    this.connection.prepare(projectRootMigrationUpdate).run(root, pipelineRoot, root, row.id);
  }

  private migrateBlobs(): void {
    const columns = tableColumns(this.connection, "blobs");
    addColumn(this.connection, columns, "paused", "INTEGER NOT NULL DEFAULT 0");
    addColumn(this.connection, columns, "pipelineId", "TEXT NOT NULL DEFAULT ''");
    if (!columns.has("projectId")) {
      const at = new Date().toISOString();
      this.connection.prepare(projectMigrationInsert).run(at, at);
      this.connection.exec("ALTER TABLE blobs ADD COLUMN projectId TEXT NOT NULL DEFAULT 'default'");
    }
    addColumn(this.connection, columns, "humanGateStepId", "TEXT");
    addColumn(this.connection, columns, "humanGateApprovalInputId", "TEXT");
    addColumn(this.connection, columns, "executionMode", "TEXT NOT NULL DEFAULT 'continuous'");
    addColumn(this.connection, columns, "runRequested", "INTEGER NOT NULL DEFAULT 0");
  }

  private migrateReceipts(): void {
    const columns = tableColumns(this.connection, "receipts");
    addColumn(this.connection, columns, "continuationThreadId", "TEXT");
    addColumn(this.connection, columns, "humanInputJson", "TEXT NOT NULL DEFAULT '[]'");
    addColumn(this.connection, columns, "approvalEvidenceJson", "TEXT");
    addColumn(this.connection, columns, "executionKind", "TEXT NOT NULL DEFAULT 'automated'");
    addColumn(this.connection, columns, "attestationSource", "TEXT");
    addColumn(this.connection, columns, "attestationEvidenceJson", "TEXT NOT NULL DEFAULT '[]'");
  }
}

const schema = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    root TEXT NOT NULL,
    pipelineRoot TEXT NOT NULL,
    defaultPipeline TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pipelineId TEXT NOT NULL,
    pipelinePath TEXT NOT NULL,
    inputArtifactsJson TEXT NOT NULL,
    state TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    lastCompletedStepId TEXT,
    lastCompletedOrder INTEGER,
    forcedStepId TEXT,
    humanGateStepId TEXT,
    humanGateApprovalInputId TEXT,
    executionMode TEXT NOT NULL DEFAULT 'continuous',
    runRequested INTEGER NOT NULL DEFAULT 0,
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
    executionKind TEXT NOT NULL DEFAULT 'automated',
    adapter TEXT NOT NULL,
    attestationSource TEXT,
    attestationEvidenceJson TEXT NOT NULL DEFAULT '[]',
    definitionGitSha TEXT NOT NULL,
    definitionHash TEXT NOT NULL,
    inputArtifactsJson TEXT NOT NULL,
    outputArtifactsJson TEXT NOT NULL,
    externalRunId TEXT,
    continuationThreadId TEXT,
    humanInputJson TEXT NOT NULL DEFAULT '[]',
    approvalEvidenceJson TEXT,
    reason TEXT,
    error TEXT,
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    invalidatedAt TEXT,
    UNIQUE(blobId, stepId, attempt)
  );

  CREATE INDEX IF NOT EXISTS receiptsByBlob ON receipts(blobId, startedAt, stepOrder);

  CREATE TABLE IF NOT EXISTS humanInputs (
    id TEXT PRIMARY KEY,
    blobId TEXT NOT NULL REFERENCES blobs(id),
    stepId TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    evidenceJson TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    receiptId TEXT REFERENCES receipts(id)
  );

  CREATE INDEX IF NOT EXISTS humanInputsByBlob ON humanInputs(blobId, stepId, createdAt);

  CREATE TABLE IF NOT EXISTS dispatcherLeases (
    name TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    leaseUntil TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`;

const projectMigrationInsert = `INSERT OR IGNORE INTO projects
  (id, name, cwd, root, pipelineRoot, defaultPipeline, createdAt, updatedAt)
  VALUES ('default', 'Default', '', '', '', 'default', ?, ?)`;
const projectRootMigrationUpdate = `UPDATE projects
  SET root = ?, pipelineRoot = ?, cwd = ? WHERE id = ?`;

function tableColumns(connection: DatabaseSync, table: string): Set<string> {
  const rows = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumn(
  connection: DatabaseSync,
  columns: Set<string>,
  name: string,
  definition: string,
): void {
  if (columns.has(name)) return;
  connection.exec(`ALTER TABLE ${columnTables[name]} ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

type ProjectMigrationRow = { id: string; cwd: string; root: string; pipelineRoot: string };

const columnTables: Record<string, string> = {
  root: "projects",
  pipelineRoot: "projects",
  paused: "blobs",
  pipelineId: "blobs",
  humanGateStepId: "blobs",
  humanGateApprovalInputId: "blobs",
  executionMode: "blobs",
  runRequested: "blobs",
  continuationThreadId: "receipts",
  humanInputJson: "receipts",
  approvalEvidenceJson: "receipts",
  executionKind: "receipts",
  attestationSource: "receipts",
  attestationEvidenceJson: "receipts",
};

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
