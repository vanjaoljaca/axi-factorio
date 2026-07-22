export class ConveyorRunner {
  private readonly store: ConveyorStore;
  private readonly harness: AgentHarness;
  private readonly instrumentation: HarnessInstrumentation;
  private readonly reconcileEveryMs: number;
  private readonly confirmTerminalAfterMs: number;
  private readonly maxConsecutiveProbeErrors: number;
  private readonly localEndpoints: LocalEndpointSupervisor | null;

  constructor(
    store: ConveyorStore,
    harness: AgentHarness,
    instrumentation: HarnessInstrumentation = noHarnessInstrumentation,
    options: RunnerOptions = {},
    localEndpoints: LocalEndpointSupervisor | null = null,
  ) {
    this.store = store;
    this.harness = harness;
    this.instrumentation = instrumentation;
    this.reconcileEveryMs = options.reconcileEveryMs ?? 30_000;
    this.confirmTerminalAfterMs = options.confirmTerminalAfterMs ?? 15_000;
    this.maxConsecutiveProbeErrors = options.maxConsecutiveProbeErrors ?? 3;
    this.localEndpoints = localEndpoints;
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

  async reconcileLocalEndpoints(): Promise<void> {
    if (!this.localEndpoints) return;
    for (const lease of this.store.pendingLocalEndpointLeases()) await this.reconcileLocalEndpoint(lease);
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
    let replacingExternalRunId: string | null = null;
    let harnessActivity = 0;
    let cancelPromise: Promise<void> | null = null;
    let cancellationReason = "Dispatcher stopped.";
    let localEndpoint: LocalEndpointSession | null = null;
    let terminalStatus: ReceiptStatus | null = null;
    const requestCancel = () => {
      if (cancelPromise) return;
      this.recordBoundary("cancel_requested", claim, { externalRunId: externalRunId ?? "" });
      const harnessCancel = this.harness.cancel({
        runId: claim.receipt.id,
        externalRunId,
        reason: signal?.reason instanceof Error ? signal.reason.message : cancellationReason,
      });
      this.store.requestLocalEndpointStop(claim.blob.id, "Receipt execution was cancelled.");
      const endpointCancel = this.localEndpoints?.stop(claim.receipt.id, localEndpoint?.pid) ?? Promise.resolve();
      cancelPromise = Promise.all([harnessCancel, endpointCancel])
        .then(() => this.recordBoundary("cancelled", claim, {}));
    };
    signal?.addEventListener("abort", requestCancel, { once: true });
    try {
      const input = harnessInput(claim);
      const observer = {
        event: (event: HarnessEvent) => {
          harnessActivity += 1;
          if (event.type === "external-run") {
            if (replacingExternalRunId && event.externalRunId !== replacingExternalRunId) {
              this.store.replaceExternalRunForRecovery(
                claim.receipt.id, replacingExternalRunId, event.externalRunId, ownerId,
              );
              replacingExternalRunId = null;
            } else {
              this.store.recordExternalRun(claim.receipt.id, event.externalRunId, ownerId);
            }
            externalRunId = event.externalRunId;
          }
          this.recordBoundary("event", claim, harnessEventAttributes(event));
        },
        startLocalEndpoint: async () => {
          if (!this.localEndpoints) return null;
          localEndpoint = await this.localEndpoints.start(claim.receipt.id, claim.blob.executionWorkspaceRoot);
          if (localEndpoint) {
            this.store.registerLocalEndpoint(claim.receipt.id, localEndpoint);
            observer.event({ type: "local-endpoint", status: "healthy", ...localEndpoint });
          }
          return localEndpoint;
        },
      };
      let running = claim.receipt.continuationThreadId
        ? this.resumeHarness(input, claim.receipt.continuationThreadId, observer, claim)
        : this.startHarness(input, observer, claim);
      let result: HarnessResult;
      let recoveries = 0;
      while (true) {
        try {
          result = await this.awaitHarness(running, claim, () => externalRunId, () => harnessActivity);
          break;
        } catch (error) {
          if (!(error instanceof RecoverableHarnessLaunchError) || recoveries || !externalRunId) throw error;
          recoveries += 1;
          const previousExternalRunId = externalRunId;
          this.recordBoundary("recovery", claim, {
            externalRunId: previousExternalRunId,
            strategy: error.strategy,
            subattempt: recoveries + 1,
          });
          if (error.strategy === "restart") {
            replacingExternalRunId = previousExternalRunId;
            externalRunId = null;
            running = this.startHarness(input, observer, claim);
          } else {
            running = this.resumeHarness(input, previousExternalRunId, observer, claim);
          }
        }
      }
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
      terminalStatus = status ?? null;
      log("receipt_completed", { receiptId: claim.receipt.id, status, blobState: blob.state });
    } catch (error) {
      if (signal?.aborted) {
        requestCancel();
        await cancelPromise;
        return this.interrupt(claim, ownerId, abortReason(signal));
      }
      cancellationReason = `Receipt execution failed: ${errorMessage(error)}`;
      requestCancel();
      await cancelPromise;
      this.recordBoundary("error", claim, { error: errorMessage(error) });
      this.store.failReceipt(claim.receipt.id, error, ownerId);
      log("receipt_failed", { receiptId: claim.receipt.id, error: errorMessage(error) });
      throw new ReceiptRunError(claim.receipt.id, error);
    } finally {
      signal?.removeEventListener("abort", requestCancel);
      if (localEndpoint && this.localEndpoints) {
        if (terminalStatus === "blocked" && this.store.getBlob(claim.blob.id)?.humanGateStepId === claim.step.id) {
          this.store.retainLocalEndpoint(claim.receipt.id);
          this.recordEndpointBoundary("retained", claim, localEndpoint);
        } else {
          await this.stopLocalEndpoint(claim, localEndpoint, "Receipt no longer owns the local endpoint.");
        }
      }
    }
  }

  private async reconcileLocalEndpoint(lease: LocalEndpointLease): Promise<void> {
    if (!this.localEndpoints) return;
    try {
      if (lease.desiredState === "stopped") {
        await this.localEndpoints.stop(lease.id, lease.pid);
        this.store.markLocalEndpointStopped(lease.id, lease.terminalReason ?? "Local endpoint stopped.");
        return;
      }
      const session = await this.localEndpoints.recover(lease);
      this.store.markLocalEndpointHealthy(lease.id, session);
    } catch (error) {
      await this.localEndpoints.stop(lease.id, lease.pid).catch((stopError) => log(
        "local_endpoint_failed_cleanup", { leaseId: lease.id, error: errorMessage(stopError) },
      ));
      this.store.markLocalEndpointFailed(lease.id, errorMessage(error));
      log("local_endpoint_recovery_failed", { leaseId: lease.id, error: errorMessage(error) });
    }
  }

  private async stopLocalEndpoint(
    claim: ClaimedExecution,
    session: LocalEndpointSession,
    reason: string,
  ): Promise<void> {
    this.store.requestLocalEndpointStop(claim.blob.id, reason);
    await this.localEndpoints!.stop(claim.receipt.id, session.pid);
    this.store.markLocalEndpointStopped(claim.receipt.id, reason);
    this.recordEndpointBoundary("stopped", claim, session);
  }

  private recordEndpointBoundary(status: string, claim: ClaimedExecution, session: LocalEndpointSession): void {
    this.recordBoundary("event", claim, {
      eventType: "local-endpoint", status, url: session.url,
      cwd: session.cwd, gitHead: session.gitHead,
    });
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
    activity: () => number,
  ): Promise<HarnessResult> {
    if (!this.harness.reconcile) return running;
    const settled = settle(running);
    let consecutiveProbeErrors = 0;
    while (true) {
      const outcome = await Promise.race([settled, delay(this.reconcileEveryMs)]);
      if (outcome) return unwrap(outcome);
      const runId = externalRunId();
      if (!runId) continue;
      try {
        await this.reconcileHarness(settled, claim, runId, activity);
        consecutiveProbeErrors = 0;
      } catch (error) {
        if (!(error instanceof HarnessProbeError)) throw error;
        consecutiveProbeErrors += 1;
        if (consecutiveProbeErrors < this.maxConsecutiveProbeErrors) continue;
        throw new Error(
          `External run ${runId} lifecycle probe failed ${consecutiveProbeErrors} consecutive times: ${error.message}`,
        );
      }
    }
  }

  private async reconcileHarness(
    settled: Promise<SettledHarness>,
    claim: ClaimedExecution,
    externalRunId: string,
    activity: () => number,
  ): Promise<void> {
    const observedActivity = activity();
    const first = await this.readExternalState(claim, externalRunId);
    if (!first || first.status === "running") return;
    const outcome = await Promise.race([settled, delay(this.confirmTerminalAfterMs)]);
    if (outcome) return void unwrap(outcome);
    if (activity() !== observedActivity) return;
    const confirmed = await this.readExternalState(claim, externalRunId);
    if (!confirmed || confirmed.status !== first.status) return;
    await this.cancelReconciledRun(claim, externalRunId, confirmed.reason);
    if (confirmed.status === "interrupted" && confirmed.recovery) {
      throw new RecoverableHarnessLaunchError(externalRunId, confirmed.reason, confirmed.recovery);
    }
    throw new Error(`External run ${externalRunId} ${confirmed.status}: ${confirmed.reason}`);
  }

  private async readExternalState(
    claim: ClaimedExecution,
    externalRunId: string,
  ): Promise<HarnessExternalState> {
    try {
      const state = await this.harness.reconcile!({
        runId: claim.receipt.id, externalRunId, blob: claim.blob, step: claim.step,
      });
      this.recordBoundary("reconcile", claim, {
        externalRunId, status: state.status, reason: "reason" in state ? state.reason : "",
        recovery: "recovery" in state ? state.recovery ?? "" : "",
      });
      return state;
    } catch (error) {
      this.recordBoundary("reconcile", claim, {
        externalRunId, status: "probe-error", reason: errorMessage(error),
      });
      throw new HarnessProbeError(errorMessage(error));
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
  if (event.type === "local-endpoint") return {
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

class RecoverableHarnessLaunchError extends Error {
  readonly externalRunId: string;
  readonly strategy: "resume" | "restart";

  constructor(externalRunId: string, reason: string, strategy: "resume" | "restart") {
    super(reason);
    this.externalRunId = externalRunId;
    this.strategy = strategy;
  }
}

class HarnessProbeError extends Error {}

type RunnerOptions = {
  reconcileEveryMs?: number;
  confirmTerminalAfterMs?: number;
  maxConsecutiveProbeErrors?: number;
};

type SettledHarness = { result: HarnessResult } | { error: unknown };

import type { ClaimedExecution, StepDefinition, Blob, ReceiptStatus, LocalEndpointLease } from "./Types.ts";
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
import type { LocalEndpointSession } from "./LocalEndpointSupervisor.ts";
import { discoverPipeline, nextStep, snapshotDefinition } from "./Pipeline.ts";
import { noHarnessInstrumentation } from "./HarnessInstrumentation.ts";
import { log } from "./Logger.ts";
import { LocalEndpointSupervisor } from "./LocalEndpointSupervisor.ts";
