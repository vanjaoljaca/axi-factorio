export class ConveyorRunner {
  private readonly store: ConveyorStore;
  private readonly harness: AgentHarness;
  private readonly instrumentation: HarnessInstrumentation;

  constructor(
    store: ConveyorStore,
    harness: AgentHarness,
    instrumentation: HarnessInstrumentation = noHarnessInstrumentation,
  ) {
    this.store = store;
    this.harness = harness;
    this.instrumentation = instrumentation;
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
      blobId: blob.id, step, definition, adapter: this.harness.name, inputArtifacts,
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
    let externalRunId = claim.receipt.continuationThreadId;
    let cancelPromise: Promise<void> | null = null;
    const requestCancel = () => {
      if (cancelPromise) return;
      this.recordBoundary("cancel_requested", claim, { externalRunId: externalRunId ?? "" });
      cancelPromise = this.harness.cancel({
        runId: claim.receipt.id,
        externalRunId,
        reason: signal?.reason instanceof Error ? signal.reason.message : "Dispatcher stopped.",
      }).then(() => this.recordBoundary("cancelled", claim, {}));
    };
    signal?.addEventListener("abort", requestCancel, { once: true });
    try {
      const input = harnessInput(claim);
      const observer = {
        event: (event: HarnessEvent) => {
          if (event.type === "external-run") {
            externalRunId = event.externalRunId;
            this.store.recordExternalRun(claim.receipt.id, externalRunId, ownerId);
          }
          this.recordBoundary("event", claim, harnessEventAttributes(event));
        },
      };
      const result = claim.receipt.continuationThreadId
        ? await this.resumeHarness(input, claim.receipt.continuationThreadId, observer, claim)
        : await this.startHarness(input, observer, claim);
      if (result.externalRunId) {
        externalRunId = result.externalRunId;
        this.store.recordExternalRun(claim.receipt.id, externalRunId, ownerId);
      }
      this.recordBoundary("terminal", claim, {
        decision: result.decision,
        externalRunId: result.externalRunId ?? "",
        artifactCount: result.outputArtifacts.length,
      });
      const nextStepId = followingStep(claim.step, steps)?.id ?? null;
      const blob = this.store.completeReceipt(claim.receipt.id, {
        status: result.decision,
        reason: result.reason,
        outputArtifacts: result.outputArtifacts,
        externalRunId: result.externalRunId,
      }, nextStepId, ownerId);
      const status = this.store.listReceipts(blob.id).find((receipt) => receipt.id === claim.receipt.id)?.status;
      log("receipt_completed", { receiptId: claim.receipt.id, status, blobState: blob.state });
    } catch (error) {
      if (signal?.aborted) {
        requestCancel();
        await cancelPromise;
        return this.interrupt(claim, ownerId);
      }
      this.recordBoundary("error", claim, { error: errorMessage(error) });
      this.store.failReceipt(claim.receipt.id, error, ownerId);
      log("receipt_failed", { receiptId: claim.receipt.id, error: errorMessage(error) });
      throw new ReceiptRunError(claim.receipt.id, error);
    } finally {
      signal?.removeEventListener("abort", requestCancel);
    }
  }

  private async startHarness(
    input: HarnessRunInput,
    observer: HarnessObserver,
    claim: ClaimedExecution,
  ): Promise<HarnessResult> {
    this.recordBoundary("start", claim, {});
    return this.harness.start(input, observer);
  }

  private async resumeHarness(
    input: HarnessRunInput,
    externalRunId: string,
    observer: HarnessObserver,
    claim: ClaimedExecution,
  ): Promise<HarnessResult> {
    this.recordBoundary("resume", claim, { externalRunId });
    return this.harness.resume({ ...input, externalRunId }, observer);
  }

  private recordBoundary(
    phase: HarnessBoundaryPhase,
    claim: ClaimedExecution,
    attributes: Record<string, string | number | boolean>,
  ): void {
    const event = {
      name: `axi_factorio.harness.${phase}` as const,
      timestamp: new Date().toISOString(),
      attributes: {
        harness: this.harness.name,
        blobId: claim.blob.id,
        stepId: claim.step.id,
        runId: claim.receipt.id,
        ...attributes,
      },
    };
    this.store.recordExecutionEvent(
      claim.receipt.id, claim.blob.id, claim.step.id, event.name, event.attributes,
    );
    try {
      this.instrumentation.record(event);
    } catch (error) {
      log("harness_instrumentation_failed", {
        harness: this.harness.name,
        runId: claim.receipt.id,
        error: errorMessage(error),
      });
    }
  }

  private interrupt(claim: ClaimedExecution, ownerId?: string): void {
    this.store.interruptReceipt(claim.receipt.id, ownerId);
    log("receipt_interrupted", { receiptId: claim.receipt.id });
  }
}

function harnessInput(claim: ClaimedExecution): HarnessRunInput {
  return {
    runId: claim.receipt.id,
    blob: claim.blob,
    step: claim.step,
    definition: claim.definition,
    inputArtifacts: claim.receipt.inputArtifacts,
    humanInputs: claim.receipt.humanInputs,
    approvalEvidence: claim.receipt.approvalEvidence,
  };
}

function harnessEventAttributes(event: HarnessEvent): Record<string, string> {
  if (event.type === "external-run") return { eventType: event.type, externalRunId: event.externalRunId };
  if (event.type === "artifact") return { eventType: event.type, artifactRef: event.artifactRef };
  return { eventType: event.type, status: event.status, message: event.message ?? "" };
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
import type {
  AgentHarness,
  HarnessEvent,
  HarnessObserver,
  HarnessResult,
  HarnessRunInput,
} from "./Harness.ts";
import type {
  HarnessBoundaryPhase,
  HarnessInstrumentation,
} from "./HarnessInstrumentation.ts";
import type { ConveyorStore } from "./Store.ts";
import { discoverPipeline, nextStep, snapshotDefinition } from "./Pipeline.ts";
import { noHarnessInstrumentation } from "./HarnessInstrumentation.ts";
import { log } from "./Logger.ts";
