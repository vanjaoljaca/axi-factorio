export class CoupledServiceRecoveryScenario {
  private frames: ServiceRecoveryFrame[] = [readyFrame()];

  snapshot(): ServiceRecoveryScenario {
    return { id: scenarioId, frames: this.frames };
  }

  async play(): Promise<ServiceRecoveryScenario> {
    const harness = createTestHarness();
    try {
      const receipt = createStrandedReceipt(harness);
      this.frames = [readyFrame(), frame("lease-lost", receipt, "Dispatcher lease is lost; shutdown begins.")];
      const disposition = await coupledDisposition();
      this.frames.push(frame(disposition, receipt, disposition === "stranded"
        ? "Viewer stopped listening, but the launchd unit did not exit."
        : "Coupled shutdown returned control to launchd."));
      harness.store.recoverInterruptedReceipts();
      const recovered = harness.store.listReceipts(blobId).at(-1)!;
      this.frames.push(frame("reconciled", recovered, "The original receipt is terminal and retryable; no new attempt exists."));
      return this.snapshot();
    } finally {
      harness.dispose();
    }
  }

  reset(): ServiceRecoveryScenario {
    this.frames = [readyFrame()];
    return this.snapshot();
  }
}

async function coupledDisposition(): Promise<"restarted" | "stranded"> {
  const controller = new AbortController();
  let releaseViewer!: () => void;
  const viewer = new Promise<void>((resolve) => releaseViewer = resolve);
  const coupled = runCoupledService(controller, Promise.reject(new Error("dispatcher lease lost")), viewer, 20);
  const disposition = await Promise.race([
    coupled.then(() => "restarted" as const, () => "restarted" as const),
    delay(75).then(() => "stranded" as const),
  ]);
  releaseViewer();
  await coupled.catch(() => undefined);
  return disposition;
}

function createStrandedReceipt(harness: TestHarness): Receipt {
  harness.store.createBlob(blobId, {
    title: "Protected task", body: "Fixture input", cwd: dirname(harness.pipelinePath),
    pipelinePath: harness.pipelinePath, inputArtifacts: [],
  });
  harness.store.requestStep(blobId);
  harness.store.acquireLease(ownerId, 1_000);
  const step = harness.steps[0];
  const receipt = harness.store.beginReceipt({
    blobId, step, definition: snapshotDefinition(step, harness.pipelinePath),
    adapter: "fixture-harness", model: null, reasoningEffort: null, inputArtifacts: [],
  }, ownerId).receipt;
  harness.store.recordExternalRun(receipt.id, externalRunId, ownerId);
  harness.store.releaseLease(ownerId);
  return harness.store.listReceipts(blobId).at(-1)!;
}

function readyFrame(): ServiceRecoveryFrame {
  return frame("ready", null, "Play the coupled listener and dispatcher failure.");
}

function frame(phase: ServiceRecoveryPhase, receipt: Receipt | null, description: string): ServiceRecoveryFrame {
  const status = receipt?.status ?? "queued";
  return {
    name: "Coupled service recovery", description, source: "scenario",
    steps: ["listener", "dispatcher", "recovery"].map((id) => ({ id, label: id })),
    blobs: [{ id: blobId, title: "Protected task", state: status, stepId: phase === "reconciled" ? "recovery" : "dispatcher" }],
    receipts: receipt ? [{ id: receipt.id, blobId, stepId: receipt.stepId, status, at: "fixture", detail: receipt.error ?? `attempt ${receipt.attempt}` }] : [],
    assertions: [
      { label: "Listener failure cannot strand the launchd parent", passed: phase !== "stranded" },
      { label: "Original running receipt becomes terminal without a new attempt", passed: phase !== "reconciled" || receipt?.status === "interrupted" },
    ],
    visual: { kind: "service-recovery", phase },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export type ServiceRecoveryPhase = "ready" | "lease-lost" | "stranded" | "restarted" | "reconciled";
export type ServiceRecoveryFrame = {
  name: string; description: string; source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: Array<{ id: string; blobId: string; stepId: string; status: string; at: string; detail: string }>;
  assertions: Array<{ label: string; passed: boolean }>;
  visual: { kind: "service-recovery"; phase: ServiceRecoveryPhase };
};
export type ServiceRecoveryScenario = { id: string; frames: ServiceRecoveryFrame[] };

const scenarioId = "coupled-service-recovery";
const blobId = "fixture-protected-task";
const ownerId = "fixture-dispatcher";
const externalRunId = "fixture:interrupted-task";

import type { Receipt } from "../../src/Types.ts";
import { snapshotDefinition } from "../../src/Pipeline.ts";
import { runCoupledService } from "../../src/ServiceRuntime.ts";
import { createTestHarness, type TestHarness } from "./CreateTestHarness.ts";
import { dirname } from "node:path";
