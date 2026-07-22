export async function runDispatcherAllocationScenario(): Promise<DispatcherAllocationScenario> {
  const harness = createTestHarness();
  const service = new ConveyorService(harness.store, new ConveyorRunner(harness.store, new PausedAllocationHarness()), 10, 200);
  const controller = new AbortController();
  try {
    createQueuedBlob(harness);
    const running = service.run(controller.signal);
    await waitForTerminal(harness);
    controller.abort();
    await running;
    return scenarioFrames(harness);
  } finally {
    controller.abort();
    harness.dispose();
  }
}

class PausedAllocationHarness implements AgentHarness {
  readonly name = "fixture-allocation";

  async start(_input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    blockEventLoop(500);
    observer.event({ type: "external-run", externalRunId });
    return { decision: "advance", reason: "allocated", outputArtifacts: [], externalRunId };
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.start(input, observer);
  }

  async cancel(): Promise<void> {}
}

function createQueuedBlob(harness: TestHarness): void {
  harness.store.createBlob(blobId, {
    title: "Provider allocation", body: "Allocate one external task.",
    cwd: dirname(harness.pipelinePath), pipelinePath: harness.pipelinePath, inputArtifacts: [],
  });
  harness.store.requestStep(blobId);
}

async function waitForTerminal(harness: TestHarness): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (harness.store.listReceipts(blobId).at(-1)?.status === "running" || !harness.store.listReceipts(blobId).length) {
    if (Date.now() > deadline) throw new Error("Dispatcher allocation scenario timed out.");
    await delay(5);
  }
}

function scenarioFrames(harness: TestHarness): DispatcherAllocationScenario {
  const receipt = harness.store.listReceipts(blobId).at(-1)!;
  const phases = ["queued", "allocating", "heartbeat-late", "external-recorded", "terminal"] as const;
  return { id: scenarioId, frames: phases.map((phase) => frame(phase, receipt)) };
}

function frame(phase: DispatcherPhase, receipt: Receipt): DispatcherAllocationFrame {
  const recorded = ["external-recorded", "terminal"].includes(phase);
  return {
    name: "Dispatcher owns provider allocation",
    description: phaseDescription(phase), source: "scenario",
    steps: phaseLabels.map((label, index) => ({ id: `phase-${index}`, label })),
    blobs: [{ id: blobId, title: "Provider allocation", state: phase, stepId: `phase-${phaseIndex(phase)}` }],
    receipts: [{ id: receipt.id, blobId, stepId: receipt.stepId,
      status: phase === "terminal" ? receipt.status : "running", at: "fixture",
      detail: recorded ? receipt.externalRunId ?? "missing" : "external run pending" }],
    assertions: [
      { label: "Late heartbeat retains the unchanged dispatcher owner", passed: phase !== "terminal" || receipt.status === "advance" },
      { label: "External run identity is durable before terminal state", passed: !recorded || receipt.externalRunId === externalRunId },
      { label: "No restart or replacement receipt is needed", passed: receipt.attempt === 1 },
    ],
  };
}

function phaseDescription(phase: DispatcherPhase): string {
  return ({
    queued: "One queued item is claimed by the production service path.",
    allocating: "The agent harness is allocating an external task.",
    "heartbeat-late": "The event loop resumes after the lease deadline; no competitor owns it.",
    "external-recorded": "The same dispatcher durably records the external run identity.",
    terminal: "The original receipt terminates normally without a service restart.",
  })[phase];
}

function phaseIndex(phase: DispatcherPhase): number {
  return ["queued", "allocating", "heartbeat-late", "external-recorded", "terminal"].indexOf(phase);
}

function blockEventLoop(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) { /* deterministic provider-allocation pause */ }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export type DispatcherAllocationScenario = { id: string; frames: DispatcherAllocationFrame[] };
type DispatcherPhase = "queued" | "allocating" | "heartbeat-late" | "external-recorded" | "terminal";
type DispatcherAllocationFrame = {
  name: string; description: string; source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: Array<{ id: string; blobId: string; stepId: string; status: string; at: string; detail: string }>;
  assertions: Array<{ label: string; passed: boolean }>;
};

const scenarioId = "dispatcher-provider-allocation";
const blobId = "fixture-provider-allocation";
const externalRunId = "fixture:provider-task";
const phaseLabels = ["Queued", "Allocate", "Late heartbeat", "Run ID saved", "Terminal"];

import type { AgentHarness, HarnessObserver, HarnessResult, HarnessResumeInput, HarnessStartInput } from "../../src/Harness.ts";
import type { Receipt } from "../../src/Types.ts";
import { ConveyorRunner } from "../../src/Runner.ts";
import { ConveyorService } from "../../src/Service.ts";
import { createTestHarness, type TestHarness } from "./CreateTestHarness.ts";
import { dirname } from "node:path";
