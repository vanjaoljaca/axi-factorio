export async function runLifecycleProbeFailureScenario(): Promise<Scenario> {
  const base = createTestHarness();
  try {
    const blob = base.store.createBlob(blobId, {
      title: "Lifecycle probe unavailable",
      body: "Keep external-task truth and receipt state aligned.",
      cwd: dirname(base.pipelinePath),
      pipelinePath: base.pipelinePath,
      inputArtifacts: [],
    }).blob;
    const harness = new TimeoutProbeHarness();
    const runner = new ConveyorRunner(base.store, harness, undefined, runnerOptions);
    base.store.requestStep(blob.id);
    const before = frame("Probe unavailable", "running", harness.probes, null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Scenario safety timeout.")), safetyTimeoutMs);
    await runner.runOnce(controller.signal).catch((error) => {
      if (!(error instanceof ReceiptRunError)) throw error;
    }).finally(() => clearTimeout(timeout));
    const receipt = base.store.listReceipts(blob.id).at(-1)!;
    return {
      id: scenarioId,
      frames: [before, frame("Bounded honest failure", receipt.status, harness.probes, receipt)],
      receipt,
      probeCount: harness.probes,
    };
  } finally {
    base.dispose();
  }
}

class TimeoutProbeHarness implements AgentHarness {
  readonly name = "probe-timeout-scenario";
  readonly model = "deterministic";
  probes = 0;
  private rejectRun: ((error: Error) => void) | null = null;

  async start(_input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    observer.event({ type: "external-run", externalRunId });
    return new Promise((_resolve, reject) => this.rejectRun = reject);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.start(input, observer);
  }

  async cancel(): Promise<void> {
    this.rejectRun?.(new Error("Scenario run cancelled."));
    this.rejectRun = null;
  }

  async reconcile(): Promise<HarnessExternalState> {
    this.probes += 1;
    throw new Error("Codex lifecycle probe timed out.");
  }
}

function frame(label: string, status: string, probes: number, receipt: Receipt | null): WorkbenchFrame {
  return {
    name: "Lifecycle probe failure boundary",
    description: "Watch probe failures stop refreshing a dead receipt and become an honest retryable failure.",
    source: "scenario",
    steps: [{ id: "workbench.plan", label: "Plan" }],
    blobs: [{ id: blobId, title: "Lifecycle probe unavailable", state: status, stepId: "workbench.plan" }],
    receipts: receipt ? [{
      id: receipt.id,
      blobId: receipt.blobId,
      stepId: receipt.stepId,
      status: receipt.status,
      at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
      detail: receipt.error ?? label,
    }] : [],
    assertions: [
      { label: `${probes} consecutive probe failures observed`, passed: probes >= maxProbeFailures },
      { label: "Receipt is no longer silently running", passed: receipt?.status === "failed" },
      { label: "Blob is paused for an explicit retry", passed: receipt?.status === "failed" },
    ],
  };
}

const maxProbeFailures = 3;
const safetyTimeoutMs = 40;
const runnerOptions = {
  reconcileEveryMs: 2,
  confirmTerminalAfterMs: 2,
  maxConsecutiveProbeErrors: maxProbeFailures,
};
const scenarioId = "lifecycle-probe-failure";
const blobId = "lifecycle-probe-failure";
const externalRunId = "codex-thread:probe-timeout";

export type Scenario = { id: string; frames: WorkbenchFrame[]; receipt: Receipt; probeCount: number };
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: Array<{ id: string; blobId: string; stepId: string; status: string; at: string; detail: string }>;
  assertions: Array<{ label: string; passed: boolean }>;
};

import type {
  AgentHarness,
  HarnessExternalState,
  HarnessObserver,
  HarnessResult,
  HarnessResumeInput,
  HarnessStartInput,
} from "../../src/Harness.ts";
import type { Receipt } from "../../src/Types.ts";
import { ConveyorRunner, ReceiptRunError } from "../../src/Runner.ts";
import { createTestHarness } from "./CreateTestHarness.ts";
import { dirname } from "node:path";
