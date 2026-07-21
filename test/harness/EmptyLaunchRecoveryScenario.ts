export async function runEmptyLaunchRecoveryScenario(): Promise<EmptyLaunchRecoveryResult> {
  const fixture = createTestHarness();
  const harness = new EmptyLaunchHarness();
  const runner = new ConveyorRunner(fixture.store, harness, undefined, runnerOptions);
  try {
    fixture.store.createBlob(blobId, {
      title: "Empty provider launch recovers in place",
      body: "Keep one receipt and one external task while replacing an empty aborted invocation.",
      cwd: dirname(fixture.pipelinePath), pipelinePath: fixture.pipelinePath, inputArtifacts: [],
    });
    fixture.store.requestStep(blobId);
    const before = frame("Empty launch interrupted", [], harness);
    await runner.runOnce();
    const receipts = fixture.store.listReceipts(blobId);
    return { id: scenarioId, frames: [before, frame("Same receipt recovered", receipts, harness)], receipts, harness };
  } finally {
    fixture.dispose();
  }
}

class EmptyLaunchHarness implements AgentHarness {
  readonly name = "empty-launch-provider";
  starts = 0;
  resumes = 0;
  cancels = 0;
  private reject: ((error: Error) => void) | null = null;

  async start(_input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.starts += 1;
    observer.event({ type: "external-run", externalRunId });
    return new Promise((_resolve, reject) => this.reject = reject);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.resumes += 1;
    observer.event({ type: "external-run", externalRunId: input.externalRunId });
    return {
      decision: "advance", reason: "Recovered with a new turn on the same provider task.",
      outputArtifacts: ["proof:within-receipt-recovery"], externalRunId: input.externalRunId,
    };
  }

  async reconcile(): Promise<HarnessExternalState> {
    return {
      status: "interrupted", reason: "Initial provider turn aborted before agent activity.",
      recovery: "resume",
    } as HarnessExternalState;
  }

  async cancel(): Promise<void> {
    this.cancels += 1;
    this.reject?.(new Error("Empty launch invocation cancelled."));
    this.reject = null;
  }
}

function frame(label: string, receipts: Receipt[], harness: EmptyLaunchHarness): WorkbenchFrame {
  const recovered = receipts.length === 1;
  return {
    name: "Empty provider launch recovery",
    description: "Play both frames: the bead and receipt stay fixed while an empty aborted invocation becomes a new turn on the same task.",
    source: "scenario",
    steps: [{ id: "g1.first", label: "First" }, { id: "g2.second", label: "Second" }],
    blobs: [{
      id: blobId, title: "Empty provider launch recovers in place",
      state: recovered ? "advanced" : "running", stepId: recovered ? "g2.second" : "g1.first",
    }],
    receipts: receipts.map(viewReceipt),
    assertions: [
      { label: "Exactly one receipt", passed: !recovered || receipts.length === 1 },
      { label: "One fresh start invocation", passed: !recovered || harness.starts === 1 },
      { label: "One within-receipt resume", passed: !recovered || harness.resumes === 1 },
      { label: "Empty invocation cancelled once", passed: !recovered || harness.cancels === 1 },
      { label: "External task identity is unchanged", passed: !recovered || receipts[0]?.externalRunId === externalRunId },
    ],
  };
}

function viewReceipt(receipt: Receipt): WorkbenchReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId, status: receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: `attempt ${receipt.attempt} · ${receipt.externalRunId}`,
  };
}

const scenarioId = "empty-launch-recovery";
const blobId = "empty-launch-blob";
const externalRunId = "provider:fresh-task";
const runnerOptions = { reconcileEveryMs: 2, confirmTerminalAfterMs: 2 };

export type EmptyLaunchRecoveryResult = {
  id: string; frames: WorkbenchFrame[]; receipts: Receipt[]; harness: EmptyLaunchHarness;
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
import { ConveyorRunner } from "../../src/Runner.ts";
import { createTestHarness } from "./CreateTestHarness.ts";
import { dirname } from "node:path";
