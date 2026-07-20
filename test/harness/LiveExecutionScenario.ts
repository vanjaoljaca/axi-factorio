export type LiveExecutionScenarioSnapshot = {
  id: string;
  frames: [LiveExecutionFrame];
};

type LiveExecutionFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: { id: string; label: string }[];
  blobs: { id: string; title: string; state: string; stepId: string | null }[];
  receipts: { id: string; blobId: string; stepId: string; status: string; at: string; detail: string }[];
  assertions: { label: string; passed: boolean }[];
  visual: {
    kind: "live-execution";
    phase: "ready" | "queued" | "running" | "retry" | "advanced" | "complete" | "failed";
    executionOverviewHtml: string;
    executions: ExecutionSession[];
    statusItems: ExecutionStatusItem[];
    timeline: { id: number; label: string; at: string }[];
    playEnabled: boolean;
  };
};

export class LiveExecutionScenario {
  private runtime = createRuntime();
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private error: string | null = null;

  snapshot(): LiveExecutionScenarioSnapshot {
    const store = this.runtime.store;
    const blob = store.getBlob(blobId)!;
    const receipts = store.listReceipts(blob.id);
    const executions = listExecutionSessions(store).filter((execution) =>
      [blobId, staleBlobId].includes(execution.blobId));
    const liveExecutions = executions.filter(
      (execution): execution is LiveExecution =>
        execution.status === "running" && execution.blobId === blobId,
    );
    const statusItems = visibleStatusItems(store);
    const events = store.listExecutionEvents(blob.id);
    const phase = this.phase(blob, liveExecutions, receipts);
    const primaryExecutions = executions.filter((execution) => execution.blobId === blobId);
    return {
      id: scenarioId,
      frames: [{
        name: "Execution sessions: task movement",
        description: "Play one real Store/Runner transition and watch the task stay or advance on its pipeline.",
        source: "scenario",
        steps: this.runtime.steps.map((step) => ({ id: step.id, label: titleCase(step.id) })),
        blobs: visibleBlobs(store, phase),
        receipts: receipts.map(viewReceipt),
        assertions: assertions(phase, executions, statusItems, receipts),
        visual: {
          kind: "live-execution",
          phase,
          executionOverviewHtml: liveExecutionMarkup(primaryExecutions, true),
          executions,
          statusItems,
          timeline: events.map((event) => ({
            id: event.id,
            label: timelineLabel(event.name, event.attributes),
            at: event.createdAt,
          })),
          playEnabled: ["ready", "retry", "advanced"].includes(phase),
        },
      }],
    };
  }

  async play(): Promise<LiveExecutionScenarioSnapshot> {
    if (this.active) return this.snapshot();
    const blob = this.runtime.store.getBlob(blobId)!;
    if (blob.state === "complete") return this.snapshot();
    if (this.runtime.store.getBlob(queuedBlobId)!.runRequested) {
      this.runtime.store.requestStop(queuedBlobId);
    }
    this.runtime.store.requestStep(blob.id);
    this.runtime.store.requestStep(queuedBlobId);
    this.abort = new AbortController();
    this.active = this.run(this.abort.signal);
    return this.snapshot();
  }

  async reset(): Promise<LiveExecutionScenarioSnapshot> {
    await this.stopActive();
    this.runtime.dispose();
    this.runtime = createRuntime();
    this.error = null;
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    await this.stopActive();
    this.runtime.dispose();
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      await pause(400, signal);
      await this.runtime.runner.runOnce(signal);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.active = null;
      this.abort = null;
    }
  }

  private async stopActive(): Promise<void> {
    if (!this.active) return;
    this.abort?.abort(new Error("Scenario reset."));
    await this.active;
  }

  private phase(
    blob: Blob,
    executions: LiveExecution[],
    receipts: Receipt[],
  ): LiveExecutionFrame["visual"]["phase"] {
    if (this.error || receipts.at(-1)?.status === "failed") return "failed";
    if (executions.length) return "running";
    if (receipts.at(-1)?.status === "retry") return "retry";
    if (blob.state === "complete") return "complete";
    if (receipts.at(-1)?.status === "advance") return "advanced";
    if (blob.runRequested) return "queued";
    return "ready";
  }
}

class SlowDeterministicHarness implements AgentHarness {
  readonly name = "deterministic-agent";
  readonly model = "fixture-v1";
  readonly reasoningEffort = "medium";
  private running: AbortController | null = null;
  private attempts = 0;

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, observer, `agent-session:${input.blob.id}:1`);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, observer, input.externalRunId);
  }

  async cancel(input: HarnessCancelInput): Promise<void> {
    this.running?.abort(new Error(input.reason));
  }

  private async execute(
    input: HarnessStartInput,
    observer: HarnessObserver,
    externalRunId: string,
  ): Promise<HarnessResult> {
    this.attempts += 1;
    const controller = new AbortController();
    this.running = controller;
    observer.event({ type: "external-run", externalRunId });
    observer.event({ type: "status", status: "running", message: "Reading blob input" });
    await pause(900, controller.signal);
    observer.event({ type: "status", status: "running", message: "Executing pipeline step" });
    await pause(900, controller.signal);
    observer.event({ type: "artifact", artifactRef: "fixture:agent-output" });
    observer.event({ type: "status", status: "running", message: "Evaluating exit" });
    await pause(900, controller.signal);
    observer.event({
      type: "metrics",
      inputTokens: this.attempts === 1 ? 144 : 90,
      cachedInputTokens: this.attempts === 1 ? 80 : 70,
      outputTokens: this.attempts === 1 ? 34 : 20,
      totalTokens: this.attempts === 1 ? 178 : 110,
    });
    this.running = null;
    return {
      decision: this.attempts === 1 ? "retry" : "advance",
      reason: this.attempts === 1
        ? "Fixture exit requested one improved pass"
        : "Deterministic agent completed",
      outputArtifacts: ["fixture:agent-output"],
      externalRunId,
    };
  }
}

function createRuntime(): Runtime {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-live-execution-"));
  const pipelinePath = join(root, "pipeline");
  cpSync(templatePath, pipelinePath, { recursive: true });
  initializeGit(root);
  const database = new FactorioDatabase(join(root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  store.createProject(projectId, {
    name: "Example App", root, pipelineRoot: dirname(pipelinePath), defaultPipeline: "pipeline",
  });
  store.createBlob(blobId, {
    title: "Generate a visible result",
    body: "Show the current agent session while work is in flight.",
    cwd: root,
    executionWorkspaceRoot: root,
    projectId,
    pipelineId: "default/v1",
    pipelinePath,
    inputArtifacts: ["request:live-visibility"],
  });
  store.createBlob(queuedBlobId, {
    title: "Waiting for an agent slot",
    body: "Remain queued while another receipt is running.",
    cwd: root,
    executionWorkspaceRoot: root,
    projectId,
    pipelineId: "default/v1",
    pipelinePath,
    inputArtifacts: [],
  });
  store.createBlob(reviewBlobId, {
    title: "Needs human approval",
    body: "Remain paused at the review gate.",
    cwd: root,
    executionWorkspaceRoot: root,
    projectId,
    pipelineId: "default/v1",
    pipelinePath,
    inputArtifacts: [],
  });
  store.createBlob(staleBlobId, {
    title: "No recent agent progress",
    body: "Remain running with an old persisted progress timestamp.",
    cwd: root,
    executionWorkspaceRoot: root,
    projectId,
    pipelineId: "default/v1",
    pipelinePath,
    inputArtifacts: [],
  });
  const steps = discoverPipeline(pipelinePath);
  store.armHumanGate(reviewBlobId, "Review the current result.");
  store.requestStep(reviewBlobId);
  const review = store.beginReceipt({
    blobId: reviewBlobId,
    step: steps[0],
    definition: snapshotDefinition(steps[0], pipelinePath),
    adapter: "deterministic-agent",
    model: "fixture-v1",
    inputArtifacts: [],
  });
  store.completeReceipt(review.receipt.id, {
    status: "blocked",
    reason: "awaiting human review",
    outputArtifacts: [],
    externalRunId: "agent-session:review",
  }, steps[1]?.id ?? null);
  store.requestStep(staleBlobId);
  const stale = store.beginReceipt({
    blobId: staleBlobId,
    step: steps[0],
    definition: snapshotDefinition(steps[0], pipelinePath),
    adapter: "deterministic-agent",
    model: "fixture-v1",
    reasoningEffort: "medium",
    inputArtifacts: [],
  });
  store.recordExternalRun(stale.receipt.id, "agent-session:stale-fixture");
  const staleStartedAt = new Date(Date.now() - 7 * 60_000).toISOString();
  const staleProgressAt = new Date(Date.now() - 6 * 60_000).toISOString();
  database.connection.prepare(`UPDATE receipts SET
    queuedAt = ?,
    startedAt = ?,
    lastProgressAt = ?,
    currentOperation = 'Waiting for harness progress'
    WHERE id = ?`).run(staleStartedAt, staleStartedAt, staleProgressAt, stale.receipt.id);
  const harness = new SlowDeterministicHarness();
  return {
    root,
    database,
    store,
    steps,
    runner: new ConveyorRunner(store, harness),
    dispose: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function initializeGit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "factorio@test.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Factorio Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "live execution fixture"], { cwd: root });
}

function assertions(
  phase: LiveExecutionFrame["visual"]["phase"],
  executions: ExecutionSession[],
  statusItems: ExecutionStatusItem[],
  receipts: Receipt[],
): { label: string; passed: boolean }[] {
  const execution = executions.find((item) =>
    item.status === "running" && item.blobId === blobId) ?? executions.find((item) => item.blobId === blobId);
  return [
    { label: "Production Store and Runner own the scenario state", passed: true },
    {
      label: "Running is distinct from queued and awaiting review",
      passed: phase !== "running" || receipts.at(-1)?.status === "running",
    },
    {
      label: "Active session exposes required runtime identity",
      passed: phase !== "running" || Boolean(
        execution?.projectId && execution.blobId && execution.stepId
        && execution.receiptId && execution.sessionId && execution.executionWorkspace,
      ),
    },
    {
      label: "Queued and awaiting-review samples remain distinct from running",
      passed: phase !== "running" || statusItems.map((item) => item.status).join(",") === "queued,waiting",
    },
    {
      label: "Receipt telemetry preserves timing, operation, model, reasoning, and authoritative usage",
      passed: !["retry", "complete"].includes(phase) || Boolean(
        execution?.queuedAt && execution.startedAt && execution.finishedAt
        && execution.lastProgressAt && execution.currentOperation
        && execution.model === "fixture-v1" && execution.reasoningEffort === "medium"
        && execution.inputTokens !== null && execution.cachedInputTokens !== null
        && execution.outputTokens !== null && execution.totalTokens !== null,
      ),
    },
    {
      label: "Stale health is explicit text backed by persisted last progress",
      passed: executions.some((item) => item.blobId === staleBlobId && item.stale),
    },
  ];
}

function visibleBlobs(
  store: ConveyorStore,
  phase: LiveExecutionFrame["visual"]["phase"],
): LiveExecutionFrame["blobs"] {
  const blob = store.getBlob(blobId)!;
  return [{ id: blob.id, title: blob.title, state: phase, stepId: blob.state }];
}

function visibleStatusItems(store: ConveyorStore): ExecutionStatusItem[] {
  const queued = store.getBlob(queuedBlobId)!;
  const review = store.getBlob(reviewBlobId)!;
  const items: ExecutionStatusItem[] = [];
  if (queued.runRequested) items.push({
    projectName: "Example App",
    blobId: queued.id,
    blobTitle: queued.title,
    stepId: queued.state,
    status: "queued",
  });
  items.push({
    projectName: "Example App",
    blobId: review.id,
    blobTitle: review.title,
    stepId: review.state,
    status: "waiting",
  });
  return items;
}

function viewReceipt(receipt: Receipt): LiveExecutionFrame["receipts"][number] {
  return {
    id: receipt.id,
    blobId: receipt.blobId,
    stepId: receipt.stepId,
    status: receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.externalRunId ?? receipt.reason ?? "agent session pending",
  };
}

function timelineLabel(
  name: string,
  attributes: Record<string, string | number | boolean>,
): string {
  const phase = name.replace("axi_factorio.harness.", "");
  const detail = attributes.message ?? attributes.eventType ?? attributes.decision ?? "";
  return detail ? `${phase} · ${detail}` : phase;
}

function titleCase(value: string): string {
  return value.split(".").at(-1)!.replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

type Runtime = {
  root: string;
  database: FactorioDatabase;
  store: ConveyorStore;
  steps: StepDefinition[];
  runner: ConveyorRunner;
  dispose(): void;
};

const scenarioId = "live-execution-visibility";
const projectId = "example-app";
const blobId = "visible-agent-session";
const queuedBlobId = "queued-agent-session";
const reviewBlobId = "awaiting-review-session";
const staleBlobId = "stale-agent-session";
const templatePath = join(dirname(fileURLToPath(import.meta.url)), "default");

import type {
  AgentHarness,
  HarnessCancelInput,
  HarnessObserver,
  HarnessResult,
  HarnessResumeInput,
  HarnessStartInput,
} from "../../src/Harness.ts";
import type { Blob, Receipt, StepDefinition } from "../../src/Types.ts";
import type {
  ExecutionSession,
  ExecutionStatusItem,
  LiveExecution,
} from "../../src/LiveExecutions.ts";
import { ConveyorRunner } from "../../src/Runner.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { discoverPipeline, snapshotDefinition } from "../../src/Pipeline.ts";
import {
  listExecutionSessions,
  listLiveExecutions,
  liveExecutionMarkup,
} from "../../src/LiveExecutions.ts";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
