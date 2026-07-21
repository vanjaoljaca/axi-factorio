export class ConveyorRunner {
  private readonly store: ConveyorStore;
  private readonly harness: AgentHarness;
  private readonly instrumentation: HarnessInstrumentation;
  private readonly reconcileEveryMs: number;
  private readonly confirmTerminalAfterMs: number;
  private readonly reviewServers: ReviewServerSupervisor | null;

  constructor(
    store: ConveyorStore,
    harness: AgentHarness,
    instrumentation: HarnessInstrumentation = noHarnessInstrumentation,
    options: RunnerOptions = {},
    reviewServers: ReviewServerSupervisor | null = null,
  ) {
    this.store = store;
    this.harness = harness;
    this.instrumentation = instrumentation;
    this.reconcileEveryMs = options.reconcileEveryMs ?? 30_000;
    this.confirmTerminalAfterMs = options.confirmTerminalAfterMs ?? 2_000;
    this.reviewServers = reviewServers;
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
      blobId: blob.id, step, definition, adapter: this.harness.name,
      model: this.harness.model ?? null,
      reasoningEffort: this.harness.reasoningEffort ?? null,
      inputArtifacts,
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
    let reviewServer: ReviewServerSession | null = null;
    const requestCancel = () => {
      if (cancelPromise) return;
      this.recordBoundary("cancel_requested", claim, { externalRunId: externalRunId ?? "" });
      const harnessCancel = this.harness.cancel({
        runId: claim.receipt.id,
        externalRunId,
        reason: signal?.reason instanceof Error ? signal.reason.message : "Dispatcher stopped.",
      });
      const reviewCancel = this.reviewServers?.stop(claim.receipt.id) ?? Promise.resolve();
      cancelPromise = Promise.all([harnessCancel, reviewCancel])
        .then(() => this.recordBoundary("cancelled", claim, {}));
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
        startReviewServer: async () => {
          if (!this.reviewServers) return null;
          reviewServer = await this.reviewServers.start(claim.receipt.id, claim.blob.executionWorkspaceRoot);
          if (reviewServer) observer.event({ type: "review-server", status: "healthy", ...reviewServer });
          return reviewServer;
        },
      };
      const running = claim.receipt.continuationThreadId
        ? this.resumeHarness(input, claim.receipt.continuationThreadId, observer, claim)
        : this.startHarness(input, observer, claim);
      const result = await this.awaitHarness(running, claim, () => externalRunId);
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
        return this.interrupt(claim, ownerId, abortReason(signal));
      }
      this.recordBoundary("error", claim, { error: errorMessage(error) });
      this.store.failReceipt(claim.receipt.id, error, ownerId);
      log("receipt_failed", { receiptId: claim.receipt.id, error: errorMessage(error) });
      throw new ReceiptRunError(claim.receipt.id, error);
    } finally {
      signal?.removeEventListener("abort", requestCancel);
      if (reviewServer && this.reviewServers) {
        await this.reviewServers.stop(claim.receipt.id);
        this.recordBoundary("event", claim, {
          eventType: "review-server", status: "stopped", url: reviewServer.url,
          cwd: reviewServer.cwd, gitHead: reviewServer.gitHead,
        });
      }
    }
  }

  private async startHarness(
    input: HarnessRunInput,
    observer: HarnessObserver,
    claim: ClaimedExecution,
  ): Promise<HarnessResult> {
    this.recordBoundary("start", claim, {
      projectRoot: claim.blob.cwd,
      executionWorkspaceRoot: claim.blob.executionWorkspaceRoot,
    });
    return this.harness.start(input, observer);
  }

  private async resumeHarness(
    input: HarnessRunInput,
    externalRunId: string,
    observer: HarnessObserver,
    claim: ClaimedExecution,
  ): Promise<HarnessResult> {
    this.recordBoundary("resume", claim, {
      externalRunId,
      projectRoot: claim.blob.cwd,
      executionWorkspaceRoot: claim.blob.executionWorkspaceRoot,
    });
    return this.harness.resume({ ...input, externalRunId }, observer);
  }

  private async awaitHarness(
    running: Promise<HarnessResult>,
    claim: ClaimedExecution,
    externalRunId: () => string | null,
  ): Promise<HarnessResult> {
    if (!this.harness.reconcile) return running;
    const settled = settle(running);
    while (true) {
      const outcome = await Promise.race([settled, delay(this.reconcileEveryMs)]);
      if (outcome) return unwrap(outcome);
      const runId = externalRunId();
      if (runId) await this.reconcileHarness(settled, claim, runId);
    }
  }

  private async reconcileHarness(
    settled: Promise<SettledHarness>,
    claim: ClaimedExecution,
    externalRunId: string,
  ): Promise<void> {
    const first = await this.readExternalState(claim, externalRunId);
    if (!first || first.status === "running") return;
    const outcome = await Promise.race([settled, delay(this.confirmTerminalAfterMs)]);
    if (outcome) return void unwrap(outcome);
    const confirmed = await this.readExternalState(claim, externalRunId);
    if (!confirmed || confirmed.status !== first.status) return;
    await this.cancelReconciledRun(claim, externalRunId, confirmed.reason);
    throw new Error(`External run ${externalRunId} ${confirmed.status}: ${confirmed.reason}`);
  }

  private async readExternalState(
    claim: ClaimedExecution,
    externalRunId: string,
  ): Promise<HarnessExternalState | null> {
    try {
      const state = await this.harness.reconcile!({
        runId: claim.receipt.id, externalRunId, blob: claim.blob, step: claim.step,
      });
      this.recordBoundary("reconcile", claim, {
        externalRunId, status: state.status, reason: "reason" in state ? state.reason : "",
      });
      return state;
    } catch (error) {
      this.recordBoundary("reconcile", claim, {
        externalRunId, status: "probe-error", reason: errorMessage(error),
      });
      return null;
    }
  }

  private async cancelReconciledRun(
    claim: ClaimedExecution,
    externalRunId: string,
    reason: string,
  ): Promise<void> {
    await this.harness.cancel({ runId: claim.receipt.id, externalRunId, reason });
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

  private interrupt(claim: ClaimedExecution, ownerId?: string, reason?: string): void {
    this.store.interruptReceipt(claim.receipt.id, ownerId, reason);
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

function harnessEventAttributes(event: HarnessEvent): Record<string, string | number> {
  if (event.type === "external-run") return { eventType: event.type, externalRunId: event.externalRunId };
  if (event.type === "artifact") return { eventType: event.type, artifactRef: event.artifactRef };
  if (event.type === "review-server") return {
    eventType: event.type, status: event.status, url: event.url, cwd: event.cwd, gitHead: event.gitHead,
  };
  if (event.type === "metrics") return metricAttributes(event);
  return { eventType: event.type, status: event.status, message: event.message ?? "" };
}

function metricAttributes(event: Extract<HarnessEvent, { type: "metrics" }>): Record<string, string | number> {
  const attributes: Record<string, string | number> = { eventType: event.type };
  if (event.inputTokens !== undefined) attributes.inputTokens = event.inputTokens;
  if (event.cachedInputTokens !== undefined) attributes.cachedInputTokens = event.cachedInputTokens;
  if (event.outputTokens !== undefined) attributes.outputTokens = event.outputTokens;
  if (event.totalTokens !== undefined) attributes.totalTokens = event.totalTokens;
  return attributes;
}

function followingStep(step: StepDefinition, steps: StepDefinition[]): StepDefinition | null {
  const index = steps.findIndex((candidate) => candidate.id === step.id);
  return index >= 0 ? steps[index + 1] ?? null : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Dispatcher stopped before completion.";
}

function settle(running: Promise<HarnessResult>): Promise<SettledHarness> {
  return running.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
}

function unwrap(outcome: SettledHarness): HarnessResult {
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

function delay(milliseconds: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), milliseconds));
}

export class ReceiptRunError extends Error {
  readonly receiptId: string;

  constructor(receiptId: string, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.receiptId = receiptId;
  }
}

type RunnerOptions = {
  reconcileEveryMs?: number;
  confirmTerminalAfterMs?: number;
};

type SettledHarness = { result: HarnessResult } | { error: unknown };

import type { ClaimedExecution, StepDefinition, Blob } from "./Types.ts";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessExternalState,
  HarnessObserver,
  HarnessResult,
  HarnessRunInput,
} from "./Harness.ts";
import type {
  HarnessBoundaryPhase,
  HarnessInstrumentation,
} from "./HarnessInstrumentation.ts";
import type { ConveyorStore } from "./Store.ts";
import type { ReviewServerSession } from "./ReviewServerSupervisor.ts";
import { discoverPipeline, nextStep, snapshotDefinition } from "./Pipeline.ts";
import { noHarnessInstrumentation } from "./HarnessInstrumentation.ts";
import { log } from "./Logger.ts";
import { ReviewServerSupervisor } from "./ReviewServerSupervisor.ts";
