export async function runInterruptedContinuationScenario(): Promise<InterruptedContinuationResult> {
  const fixture = createTestHarness();
  const harness = new InterruptedThenFreshHarness();
  const runner = new ConveyorRunner(fixture.store, harness, undefined, runnerOptions);
  try {
    fixture.store.createBlob(blobId, {
      title: "Interrupted task gets a fresh session",
      body: "Keep the same blob and step while replacing only the dead external task.",
      cwd: dirname(fixture.pipelinePath), pipelinePath: fixture.pipelinePath, inputArtifacts: [],
    });
    fixture.store.requestStep(blobId);
    await runner.runOnce();
    fixture.store.addHumanFeedback(blobId, "Continue after review.", ["review:1"]);
    await runExpectedFailure(runner);
    const interrupted = fixture.store.listReceipts(blobId);
    fixture.store.retryBlob(blobId);
    await runner.runOnce();
    const receipts = fixture.store.listReceipts(blobId);
    return {
      id: scenarioId,
      frames: [scenarioFrame("Interrupted external task", interrupted), scenarioFrame("Fresh task allocated", receipts)],
      receipts,
      starts: harness.starts,
      resumes: harness.resumes,
    };
  } finally {
    fixture.dispose();
  }
}

class InterruptedThenFreshHarness implements AgentHarness {
  readonly name = "fresh-task-boundary";
  starts = 0;
  resumes = 0;
  private reject: ((error: Error) => void) | null = null;

  async start(_input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.starts += 1;
    const externalRunId = this.starts === 1 ? interruptedRun : freshRun;
    observer.event({ type: "external-run", externalRunId });
    if (this.starts > 1) return { decision: "advance", reason: "Fresh task completed.", outputArtifacts: [], externalRunId };
    return { decision: "blocked", reason: "Awaiting review.", outputArtifacts: [], externalRunId };
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.resumes += 1;
    observer.event({ type: "external-run", externalRunId: input.externalRunId });
    return new Promise((_resolve, reject) => this.reject = reject);
  }

  async reconcile(): Promise<HarnessExternalState> {
    return { status: "interrupted", reason: "External task is terminally interrupted." };
  }

  async cancel(): Promise<void> {
    this.reject?.(new Error("Cancelled after terminal reconciliation."));
    this.reject = null;
  }
}

async function runExpectedFailure(runner: ConveyorRunner): Promise<void> {
  try { await runner.runOnce(); }
  catch (error) { if (!(error instanceof ReceiptRunError)) throw error; }
}

function scenarioFrame(label: string, receipts: Receipt[]): WorkbenchFrame {
  const latest = receipts.at(-1)!;
  const fresh = receipts.length > 2;
  return {
    name: "Fresh task after interruption",
    description: "Play the two frames: the bead stays on the same step while only the dead external task identity changes.",
    source: "scenario",
    steps: [{ id: "g1.first", label: "First" }, { id: "g2.second", label: "Second" }],
    blobs: [{
      id: blobId, title: "Interrupted task gets a fresh session",
      state: fresh ? "waiting" : "failed", stepId: "g1.first",
    }],
    receipts: receipts.map(viewReceipt),
    assertions: [
      { label: "Blob identity remains unchanged", passed: receipts.every((receipt) => receipt.blobId === blobId) },
      { label: "Retry remains on the same step", passed: receipts.every((receipt) => receipt.stepId === "g1.first") },
      { label: "Earlier blocked task is retained in history", passed: receipts[0]?.externalRunId === interruptedRun },
      { label: "Interrupted continuation is retained in history", passed: receipts[1]?.status === "failed" },
      { label: "Next receipt has no continuation task", passed: !fresh || latest.continuationThreadId === null },
      { label: "Next receipt allocates a fresh task", passed: !fresh || latest.externalRunId === freshRun },
    ],
  };
}

function viewReceipt(receipt: Receipt): WorkbenchReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId, status: receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: `attempt ${receipt.attempt} · ${receipt.externalRunId ?? "new task pending"}`,
  };
}

const scenarioId = "interrupted-continuation-boundary";
const blobId = "continuation-boundary-blob";
const interruptedRun = "external:interrupted";
const freshRun = "external:fresh";
const runnerOptions = { reconcileEveryMs: 2, confirmTerminalAfterMs: 2 };

export type InterruptedContinuationResult = {
  id: string; frames: WorkbenchFrame[]; receipts: Receipt[]; starts: number; resumes: number;
};
type WorkbenchFrame = {
  name: string; description: string; source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: WorkbenchReceipt[];
  assertions: Array<{ label: string; passed: boolean }>;
};
type WorkbenchReceipt = {
  id: string; blobId: string; stepId: string; status: string; at: string; detail: string;
};

import type {
  AgentHarness, HarnessExternalState, HarnessObserver, HarnessResult, HarnessResumeInput, HarnessStartInput,
} from "../../src/Harness.ts";
import type { Receipt } from "../../src/Types.ts";
import { ConveyorRunner, ReceiptRunError } from "../../src/Runner.ts";
import { createTestHarness } from "./CreateTestHarness.ts";
import { dirname } from "node:path";
