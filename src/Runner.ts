export class ConveyorRunner {
  private readonly store: ConveyorStore;
  private readonly adapter: ToolAdapter;

  constructor(store: ConveyorStore, adapter: ToolAdapter) {
    this.store = store;
    this.adapter = adapter;
  }

  async runOnce(signal?: AbortSignal, ownerId?: string): Promise<boolean> {
    signal?.throwIfAborted();
    const blob = this.store.nextQueuedBlob();
    if (!blob) return false;
    const steps = discoverPipeline(blob.pipelinePath);
    const step = nextStep(blob, steps);
    if (!step) {
      this.store.markCompleted(blob.id, ownerId);
      return true;
    }
    await this.execute(blob, step, steps, signal, ownerId);
    return true;
  }

  private async execute(
    blob: Blob,
    step: StepDefinition,
    steps: StepDefinition[],
    signal?: AbortSignal,
    ownerId?: string,
  ): Promise<void> {
    const definition = snapshotDefinition(step, blob.pipelinePath);
    const inputArtifacts = this.store.inputArtifactsFor(blob.id);
    const claim = this.store.beginReceipt({
      blobId: blob.id, step, definition, adapter: this.adapter.name, inputArtifacts,
    }, ownerId);
    log("receipt_started", { blobId: blob.id, receiptId: claim.receipt.id, stepId: step.id });
    await this.executeClaim(claim, steps, signal, ownerId);
  }

  private async executeClaim(
    claim: ClaimedExecution,
    steps: StepDefinition[],
    signal?: AbortSignal,
    ownerId?: string,
  ): Promise<void> {
    try {
      const result = await this.adapter.execute(
        { ...claim, inputArtifacts: claim.receipt.inputArtifacts, signal },
        (externalRunId) => this.store.recordExternalRun(claim.receipt.id, externalRunId, ownerId),
      );
      const nextStepId = followingStep(claim.step, steps)?.id ?? null;
      const blob = this.store.completeReceipt(claim.receipt.id, result, nextStepId, ownerId);
      log("receipt_completed", { receiptId: claim.receipt.id, status: result.status, blobState: blob.state });
    } catch (error) {
      if (signal?.aborted) return this.interrupt(claim, ownerId);
      this.store.failReceipt(claim.receipt.id, error, ownerId);
      log("receipt_failed", { receiptId: claim.receipt.id, error: errorMessage(error) });
      throw new ReceiptRunError(claim.receipt.id, error);
    }
  }

  private interrupt(claim: ClaimedExecution, ownerId?: string): void {
    this.store.interruptReceipt(claim.receipt.id, ownerId);
    log("receipt_interrupted", { receiptId: claim.receipt.id });
  }
}

function followingStep(step: StepDefinition, steps: StepDefinition[]): StepDefinition | null {
  const index = steps.findIndex((candidate) => candidate.id === step.id);
  return index >= 0 ? steps[index + 1] ?? null : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ReceiptRunError extends Error {
  readonly receiptId: string;

  constructor(receiptId: string, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.receiptId = receiptId;
  }
}

import type { ClaimedExecution, StepDefinition, Blob } from "./Types.ts";
import type { ToolAdapter } from "./Adapter.ts";
import type { ConveyorStore } from "./Store.ts";
import { discoverPipeline, nextStep, snapshotDefinition } from "./Pipeline.ts";
import { log } from "./Logger.ts";
