export class ConveyorStore {
  private readonly database: FactorioDatabase;
  private readonly now: () => string;

  constructor(
    database: FactorioDatabase,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.database = database;
    this.now = now;
  }

  createBlob(id: string, input: BlobInput): BlobMutationResult {
    return this.database.transaction(() => {
      const existing = this.getBlob(id);
      if (existing) return this.existingBlob(existing, input);
      const at = this.now();
      const initialState = discoverPipeline(input.pipelinePath)[0].id;
      this.database.connection.prepare(blobInsert).run(
        id, input.title, input.body, input.cwd, input.pipelinePath,
        JSON.stringify(input.inputArtifacts), initialState, at, at,
      );
      return { blob: this.requireBlob(id), already: false };
    });
  }

  nextQueuedBlob(): Blob | null {
    const row = this.database.connection.prepare(blobNext).get();
    return row ? mapBlob(asRecord(row)) : null;
  }

  beginReceipt(input: BeginReceiptInput, ownerId?: string): ClaimedExecution {
    return this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const blob = this.requireBlob(input.blobId);
      if (blob.state !== input.step.id || blob.paused) {
        throw new Error(`Blob ${blob.id} is not ready for ${input.step.id}.`);
      }
      const receipt = this.insertReceipt(blob, input);
      return { blob: this.requireBlob(blob.id), receipt, step: input.step, definition: input.definition };
    });
  }

  recordExternalRun(receiptId: string, externalRunId: string, ownerId?: string): void {
    this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const receipt = this.requireReceipt(receiptId);
      if (receipt.externalRunId && receipt.externalRunId !== externalRunId) {
        throw new Error("Adapter external run ID changed.");
      }
      this.database.connection.prepare(receiptExternalRunUpdate).run(externalRunId, receiptId);
    });
  }

  completeReceipt(
    receiptId: string,
    result: AdapterResult,
    nextStepId: string | null,
    ownerId?: string,
  ): Blob {
    return this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const receipt = this.requireReceipt(receiptId);
      this.finishReceipt(receipt.id, result);
      this.projectResult(receipt, result, nextStepId);
      return this.requireBlob(receipt.blobId);
    });
  }

  failReceipt(receiptId: string, error: unknown, ownerId?: string): void {
    this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const receipt = this.requireReceipt(receiptId);
      const message = error instanceof Error ? error.message : String(error);
      this.database.connection.prepare(receiptFailureUpdate).run(message, this.now(), receipt.id);
      this.database.connection.prepare(blobPauseUpdate).run(1, this.now(), receipt.blobId);
    });
  }

  interruptReceipt(receiptId: string, ownerId?: string): void {
    this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const receipt = this.requireReceipt(receiptId);
      this.database.connection.prepare(receiptInterruptUpdate).run(this.now(), receipt.id);
      this.database.connection.prepare(blobPauseUpdate).run(0, this.now(), receipt.blobId);
    });
  }

  markCompleted(blobId: string, ownerId?: string): Blob {
    return this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const blob = this.requireBlob(blobId);
      if (blob.state === "complete") return blob;
      this.database.connection.prepare(blobCompleteUpdate).run(this.now(), blob.id);
      return this.requireBlob(blob.id);
    });
  }

  retryBlob(blobId: string): BlobMutationResult {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (!blob.paused) return { blob, already: true };
      this.database.connection.prepare(blobPauseUpdate).run(0, this.now(), blob.id);
      return { blob: this.requireBlob(blob.id), already: false };
    });
  }

  rewindBlob(blobId: string, target: StepDefinition, steps: StepDefinition[]): BlobMutationResult {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (this.hasRunningReceipt(blob.id)) throw new Error("A running blob cannot be rewound.");
      const at = this.now();
      const invalidated = this.invalidateReceipts(blob.id, target, steps, at);
      const previous = this.previousValidReceipt(blob.id, target, steps);
      const already = invalidated === 0
        && blob.state === target.id
        && blob.forcedStepId === target.id;
      this.database.connection.prepare(blobRewindUpdate).run(
        target.id, previous?.stepId ?? null, previous?.stepOrder ?? null, target.id, at, blob.id,
      );
      return { blob: this.requireBlob(blob.id), already };
    });
  }

  getBlob(id: string): Blob | null {
    const row = this.database.connection.prepare(blobSelect).get(id);
    return row ? mapBlob(asRecord(row)) : null;
  }

  listBlobs(): Blob[] {
    return this.database.connection.prepare(blobList).all().map((row) => mapBlob(asRecord(row)));
  }

  listReceipts(blobId?: string): Receipt[] {
    const rows = blobId
      ? this.database.connection.prepare(receiptListByBlob).all(blobId)
      : this.database.connection.prepare(receiptList).all();
    return rows.map((row) => mapReceipt(asRecord(row)));
  }

  inputArtifactsFor(blobId: string): string[] {
    const blob = this.requireBlob(blobId);
    const refs = [...blob.inputArtifacts];
    for (const receipt of this.validAdvancedReceipts(blobId)) refs.push(...receipt.outputArtifacts);
    return [...new Set(refs)];
  }

  acquireLease(ownerId: string, leaseMs: number): boolean {
    return this.database.transaction(() => {
      const at = this.now();
      const until = new Date(Date.parse(at) + leaseMs).toISOString();
      this.database.connection.prepare(leaseDeleteExpired).run(at);
      const result = this.database.connection.prepare(leaseInsert).run(ownerId, until, at);
      return Number(result.changes) === 1;
    });
  }

  renewLease(ownerId: string, leaseMs: number): boolean {
    const at = this.now();
    const until = new Date(Date.parse(at) + leaseMs).toISOString();
    const result = this.database.connection.prepare(leaseRenew).run(until, at, ownerId, at);
    return Number(result.changes) === 1;
  }

  releaseLease(ownerId: string): void {
    this.database.connection.prepare(leaseRelease).run(ownerId);
  }

  recoverInterruptedReceipts(): number {
    return this.database.transaction(() => {
      const rows = this.database.connection.prepare(runningReceiptList).all();
      for (const row of rows) this.recoverReceipt(mapReceipt(asRecord(row)));
      return rows.length;
    });
  }

  private insertReceipt(blob: Blob, input: BeginReceiptInput): Receipt {
    const id = randomUUID();
    const at = this.now();
    const attempt = this.nextAttempt(blob.id, input.step.id);
    this.database.connection.prepare(receiptInsert).run(
      id, blob.id, input.step.id, input.step.order, attempt, input.adapter,
      input.definition.gitSha, input.definition.contentHash,
      JSON.stringify(input.inputArtifacts), at,
    );
    return this.requireReceipt(id);
  }

  private finishReceipt(receiptId: string, result: AdapterResult): void {
    this.database.connection.prepare(receiptCompleteUpdate).run(
      result.status, JSON.stringify(result.outputArtifacts), result.externalRunId,
      result.reason, this.now(), receiptId,
    );
  }

  private projectResult(receipt: Receipt, result: AdapterResult, nextStepId: string | null): void {
    if (result.status === "retry") {
      this.database.connection.prepare(blobPauseUpdate).run(0, this.now(), receipt.blobId);
      return;
    }
    if (result.status === "blocked") {
      this.database.connection.prepare(blobPauseUpdate).run(1, this.now(), receipt.blobId);
      return;
    }
    const state = nextStepId ?? "complete";
    this.database.connection.prepare(blobAdvanceUpdate).run(
      state, 0, receipt.stepId, receipt.stepOrder, this.now(), receipt.blobId,
    );
  }

  private recoverReceipt(receipt: Receipt): void {
    this.database.connection.prepare(receiptInterruptUpdate).run(this.now(), receipt.id);
    this.database.connection.prepare(blobPauseUpdate).run(0, this.now(), receipt.blobId);
  }

  private hasRunningReceipt(blobId: string): boolean {
    return Boolean(this.database.connection.prepare(runningReceiptByBlob).get(blobId));
  }

  private invalidateReceipts(
    blobId: string,
    target: StepDefinition,
    steps: StepDefinition[],
    at: string,
  ): number {
    const targetIndex = steps.findIndex((step) => step.id === target.id);
    const currentIds = new Set(steps.map((step) => step.id));
    const laterIds = new Set(steps.slice(targetIndex).map((step) => step.id));
    const receipts = this.listReceipts(blobId).filter((receipt) =>
      !receipt.invalidatedAt
      && (laterIds.has(receipt.stepId)
        || (!currentIds.has(receipt.stepId) && receipt.stepOrder >= target.order)));
    for (const receipt of receipts) {
      this.database.connection.prepare(receiptInvalidate).run(at, receipt.id);
    }
    return receipts.length;
  }

  private previousValidReceipt(
    blobId: string,
    target: StepDefinition,
    steps: StepDefinition[],
  ): Receipt | null {
    const targetIndex = steps.findIndex((step) => step.id === target.id);
    const receipts = this.listReceipts(blobId).filter((receipt) =>
      receipt.status === "advance" && !receipt.invalidatedAt);
    for (const step of steps.slice(0, targetIndex).reverse()) {
      const receipt = receipts.filter((candidate) => candidate.stepId === step.id).at(-1);
      if (receipt) return receipt;
    }
    return null;
  }

  private validAdvancedReceipts(blobId: string): Receipt[] {
    const rows = this.database.connection.prepare(validAdvancedReceiptList).all(blobId);
    return rows.map((row) => mapReceipt(asRecord(row)));
  }

  private nextAttempt(blobId: string, stepId: string): number {
    const row = this.database.connection.prepare(attemptSelect).get(blobId, stepId);
    return Number(asRecord(row).attempt);
  }

  private requireBlob(id: string): Blob {
    const blob = this.getBlob(id);
    if (!blob) throw new Error(`Blob ${id} was not found.`);
    return blob;
  }

  private requireReceipt(id: string): Receipt {
    const row = this.database.connection.prepare(receiptSelect).get(id);
    if (!row) throw new Error(`Receipt ${id} was not found.`);
    return mapReceipt(asRecord(row));
  }

  private requireActiveLease(ownerId?: string): void {
    if (!ownerId) return;
    const row = this.database.connection.prepare(activeLeaseSelect).get(ownerId, this.now());
    if (!row) throw new Error("The axi-factorio dispatcher lease was lost.");
  }

  private existingBlob(blob: Blob, input: BlobInput): BlobMutationResult {
    if (sameBlobInput(blob, input)) return { blob, already: true };
    throw new Error(`Blob ${blob.id} already exists with different input.`);
  }
}

function mapBlob(row: Record<string, unknown>): Blob {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    cwd: String(row.cwd),
    pipelinePath: String(row.pipelinePath),
    inputArtifacts: JSON.parse(String(row.inputArtifactsJson)) as string[],
    state: row.state as BlobState,
    paused: Boolean(row.paused),
    lastCompletedStepId: nullableString(row.lastCompletedStepId),
    lastCompletedOrder: nullableNumber(row.lastCompletedOrder),
    forcedStepId: nullableString(row.forcedStepId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function mapReceipt(row: Record<string, unknown>): Receipt {
  return {
    id: String(row.id),
    blobId: String(row.blobId),
    stepId: String(row.stepId),
    stepOrder: Number(row.stepOrder),
    attempt: Number(row.attempt),
    status: row.status as ReceiptStatus,
    adapter: String(row.adapter),
    definitionGitSha: String(row.definitionGitSha),
    definitionHash: String(row.definitionHash),
    inputArtifacts: JSON.parse(String(row.inputArtifactsJson)) as string[],
    outputArtifacts: JSON.parse(String(row.outputArtifactsJson)) as string[],
    externalRunId: nullableString(row.externalRunId),
    reason: nullableString(row.reason),
    error: nullableString(row.error),
    startedAt: String(row.startedAt),
    finishedAt: nullableString(row.finishedAt),
    invalidatedAt: nullableString(row.invalidatedAt),
  };
}

function sameBlobInput(blob: Blob, input: BlobInput): boolean {
  return blob.title === input.title
    && blob.body === input.body
    && blob.cwd === input.cwd
    && blob.pipelinePath === input.pipelinePath
    && JSON.stringify(blob.inputArtifacts) === JSON.stringify(input.inputArtifacts);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export type BlobMutationResult = { blob: Blob; already: boolean };

type BeginReceiptInput = {
  blobId: string;
  step: StepDefinition;
  definition: DefinitionSnapshot;
  adapter: string;
  inputArtifacts: string[];
};

const blobInsert = `INSERT INTO blobs
  (id, title, body, cwd, pipelinePath, inputArtifactsJson, state, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const blobSelect = "SELECT * FROM blobs WHERE id = ?";
const blobList = "SELECT * FROM blobs ORDER BY createdAt DESC";
const blobNext = `SELECT * FROM blobs WHERE state != 'complete' AND paused = 0
  AND NOT EXISTS (SELECT 1 FROM receipts WHERE receipts.blobId = blobs.id
    AND receipts.status = 'running' AND receipts.invalidatedAt IS NULL)
  ORDER BY updatedAt, createdAt LIMIT 1`;
const blobPauseUpdate = "UPDATE blobs SET paused = ?, updatedAt = ? WHERE id = ?";
const blobCompleteUpdate = `UPDATE blobs SET state = 'complete', paused = 0,
  forcedStepId = NULL, updatedAt = ? WHERE id = ?`;
const blobAdvanceUpdate = `UPDATE blobs SET state = ?, paused = ?, lastCompletedStepId = ?,
  lastCompletedOrder = ?, forcedStepId = NULL, updatedAt = ? WHERE id = ?`;
const blobRewindUpdate = `UPDATE blobs SET state = ?, paused = 0, lastCompletedStepId = ?,
  lastCompletedOrder = ?, forcedStepId = ?, updatedAt = ? WHERE id = ?`;
const receiptInsert = `INSERT INTO receipts
  (id, blobId, stepId, stepOrder, attempt, status, adapter, definitionGitSha,
   definitionHash, inputArtifactsJson, outputArtifactsJson, startedAt)
  VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, '[]', ?)`;
const receiptSelect = "SELECT * FROM receipts WHERE id = ?";
const receiptList = "SELECT * FROM receipts ORDER BY startedAt, stepOrder, attempt";
const receiptListByBlob = "SELECT * FROM receipts WHERE blobId = ? ORDER BY startedAt, stepOrder, attempt";
const receiptExternalRunUpdate = "UPDATE receipts SET externalRunId = ? WHERE id = ?";
const receiptCompleteUpdate = `UPDATE receipts SET status = ?, outputArtifactsJson = ?,
  externalRunId = ?, reason = ?, finishedAt = ? WHERE id = ?`;
const receiptFailureUpdate = "UPDATE receipts SET status = 'failed', error = ?, finishedAt = ? WHERE id = ?";
const receiptInterruptUpdate = "UPDATE receipts SET status = 'interrupted', finishedAt = ? WHERE id = ?";
const receiptInvalidate = "UPDATE receipts SET invalidatedAt = ? WHERE id = ?";
const validAdvancedReceiptList = `SELECT * FROM receipts WHERE blobId = ?
  AND status = 'advance' AND invalidatedAt IS NULL ORDER BY stepOrder, finishedAt`;
const runningReceiptList = `SELECT receipts.* FROM receipts JOIN blobs ON blobs.id = receipts.blobId
  WHERE receipts.status = 'running' AND receipts.invalidatedAt IS NULL`;
const runningReceiptByBlob = `SELECT 1 FROM receipts WHERE blobId = ?
  AND status = 'running' AND invalidatedAt IS NULL LIMIT 1`;
const attemptSelect = "SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM receipts WHERE blobId = ? AND stepId = ?";
const leaseDeleteExpired = "DELETE FROM dispatcherLeases WHERE name = 'runner' AND leaseUntil <= ?";
const leaseInsert = `INSERT OR IGNORE INTO dispatcherLeases
  (name, ownerId, leaseUntil, updatedAt) VALUES ('runner', ?, ?, ?)`;
const leaseRenew = `UPDATE dispatcherLeases SET leaseUntil = ?, updatedAt = ?
  WHERE name = 'runner' AND ownerId = ? AND leaseUntil > ?`;
const leaseRelease = "DELETE FROM dispatcherLeases WHERE name = 'runner' AND ownerId = ?";
const activeLeaseSelect = `SELECT 1 FROM dispatcherLeases
  WHERE name = 'runner' AND ownerId = ? AND leaseUntil > ?`;

import type {
  AdapterResult,
  ClaimedExecution,
  DefinitionSnapshot,
  Receipt,
  ReceiptStatus,
  StepDefinition,
  Blob,
  BlobInput,
  BlobState,
} from "./Types.ts";
import type { FactorioDatabase } from "./Database.ts";
import { randomUUID } from "node:crypto";
import { discoverPipeline } from "./Pipeline.ts";
