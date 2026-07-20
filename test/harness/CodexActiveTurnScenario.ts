export async function runCodexActiveTurnScenario(): Promise<CodexActiveTurnResult> {
  const fixture = createScenarioFixture();
  try {
    return await fixture.run();
  } finally {
    fixture.dispose();
  }
}

function createScenarioFixture(): ScenarioFixture {
  const base = createTestHarness();
  const root = dirname(base.pipelinePath);
  const responsePath = join(root, "codex-lifecycle.json");
  const originalPath = process.env.PATH ?? "";
  installFakeCodex(root, responsePath);
  const harness = new ActiveTurnHarness();
  const runner = new ConveyorRunner(base.store, harness, undefined, runnerOptions);
  return new ScenarioFixture(base, harness, runner, responsePath, originalPath);
}

class ScenarioFixture {
  private readonly base: TestHarness;
  private readonly harness: ActiveTurnHarness;
  private readonly runner: ConveyorRunner;
  private readonly responsePath: string;
  private readonly originalPath: string;

  constructor(
    base: TestHarness,
    harness: ActiveTurnHarness,
    runner: ConveyorRunner,
    responsePath: string,
    originalPath: string,
  ) {
    this.base = base;
    this.harness = harness;
    this.runner = runner;
    this.responsePath = responsePath;
    this.originalPath = originalPath;
  }

  async run(): Promise<CodexActiveTurnResult> {
    const blob = this.createBlob();
    const step = this.base.steps[0];
    const control = await this.readState(blob, step, "inProgress", Date.now());
    const stale = await this.readState(blob, step, "interrupted", Date.now() - staleActivityMs);
    const initial = this.frame("Before reconciliation", control.status, stale.status, null);
    writeLifecycleResponse(this.responsePath, "interrupted", Date.now());
    this.base.store.requestStep(blobId);
    await this.runSafely();
    const receipt = this.base.store.listReceipts(blobId).at(-1)!;
    return {
      id: scenarioId,
      frames: [initial, this.frame("After reconciliation", control.status, stale.status, receipt)],
      controlState: control.status, staleState: stale.status, observedReceipt: receipt,
    };
  }

  dispose(): void {
    process.env.PATH = this.originalPath;
    delete process.env.FAKE_CODEX_LIFECYCLE_RESPONSE;
    this.base.dispose();
  }

  private createBlob(): Blob {
    return this.base.store.createBlob(blobId, {
      title: "Fresh active Codex turn",
      body: "Do not interrupt fresh agent work.",
      cwd: dirname(this.base.pipelinePath),
      pipelinePath: this.base.pipelinePath,
      inputArtifacts: [],
    }).blob;
  }

  private async readState(
    blob: Blob,
    step: StepDefinition,
    status: ProviderTurnStatus,
    activityAt: number,
  ): Promise<HarnessExternalState> {
    writeLifecycleResponse(this.responsePath, status, activityAt);
    return this.harness.reconcile({
      runId: "control", externalRunId, blob, step,
    });
  }

  private async runSafely(): Promise<void> {
    try {
      await this.runner.runOnce();
    } catch (error) {
      if (!(error instanceof ReceiptRunError)) throw error;
    }
  }

  private frame(
    label: string,
    control: string,
    stale: string,
    receipt: Receipt | null,
  ): WorkbenchFrame {
    const observed = receipt?.status ?? "running";
    const expected = receipt ? "advance" : "running";
    return {
      name: "Active Codex lifecycle reconciliation",
      description: `Expected ${expected}; observed ${observed}. Production runner + SQLite receipt path.`,
      source: "scenario",
      steps: [{ id: "workbench.plan", label: "Plan" }],
      blobs: [{
        id: blobId, title: "Fresh active Codex turn",
        state: receipt?.status === "failed" ? "failed" : receipt ? "complete" : "running",
        stepId: receipt?.status === "advance" ? "complete" : "workbench.plan",
      }],
      receipts: receipt ? [viewReceipt(receipt)] : [],
      assertions: [
        { label: "notLoaded + inProgress is non-terminal", passed: control === "running" },
        { label: "Stale incomplete turn may terminalize", passed: stale === "interrupted" },
        { label: "Fresh incomplete turn is not terminalized", passed: receipt?.status !== "failed" },
        { label: "Harness work completes normally", passed: !receipt || receipt.status === "advance" },
      ],
    };
  }
}

class ActiveTurnHarness implements AgentHarness {
  readonly name = "codex-active-turn-scenario";
  readonly model = "deterministic-provider-payload";
  private readonly lifecycle = new CodexHarness();
  private active: (() => void) | null = null;

  async start(_input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    observer.event({ type: "external-run", externalRunId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(advanceResult), harnessCompletionMs);
      this.active = () => {
        clearTimeout(timer);
        reject(new Error("Scenario run cancelled by reconciliation."));
      };
    });
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.start(input, observer);
  }

  async cancel(): Promise<void> {
    this.active?.();
    this.active = null;
  }

  async reconcile(input: HarnessReconcileInput): Promise<HarnessExternalState> {
    return this.lifecycle.reconcile(input);
  }
}

function installFakeCodex(root: string, responsePath: string): void {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, "codex");
  writeFileSync(executable, fakeCodexAppServer);
  chmodSync(executable, 0o755);
  process.env.FAKE_CODEX_LIFECYCLE_RESPONSE = responsePath;
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

function writeLifecycleResponse(
  path: string,
  status: ProviderTurnStatus,
  activityAt: number,
): void {
  const turn = {
    id: "turn-active", status, error: null, completedAt: null,
    items: [{ type: "userMessage", content: [{ type: "text", text: "Continue the proof." }] }],
  };
  const thread = {
    status: { type: "notLoaded" }, updatedAt: Math.floor(activityAt / 1_000), turns: [turn],
  };
  writeFileSync(path, JSON.stringify({ id: 2, result: { thread } }));
}

function viewReceipt(receipt: Receipt): WorkbenchReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId,
    status: receipt.status, at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.error ?? receipt.reason ?? `attempt ${receipt.attempt}`,
  };
}

const fakeCodexAppServer = `#!/bin/sh
IFS= read -r initialize
printf '%s\\n' '{"id":1,"result":{"userAgent":"factorio-scenario","codexHome":"/tmp","platformFamily":"unix","platformOs":"macos"}}'
IFS= read -r request
printf '%s\\n' "$(cat "$FAKE_CODEX_LIFECYCLE_RESPONSE")"
`;
const runnerOptions = { reconcileEveryMs: 5, confirmTerminalAfterMs: 5 };
const harnessCompletionMs = 350;
const staleActivityMs = 10 * 60_000;
const scenarioId = "codex-active-turn";
const blobId = "codex-active-turn";
const externalRunId = "codex-thread:active";
const advanceResult: HarnessResult = {
  decision: "advance", reason: "Fresh agent work completed.",
  outputArtifacts: ["proof:fresh-active-turn"], externalRunId,
};

export type CodexActiveTurnResult = {
  id: string;
  frames: WorkbenchFrame[];
  controlState: string;
  staleState: string;
  observedReceipt: Receipt;
};
type ProviderTurnStatus = "inProgress" | "interrupted";
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: WorkbenchReceipt[];
  assertions: Array<{ label: string; passed: boolean }>;
};
type WorkbenchReceipt = {
  id: string;
  blobId: string;
  stepId: string;
  status: string;
  at: string;
  detail: string;
};

import type {
  AgentHarness,
  HarnessExternalState,
  HarnessObserver,
  HarnessReconcileInput,
  HarnessResult,
  HarnessResumeInput,
  HarnessStartInput,
} from "../../src/Harness.ts";
import type { Blob, Receipt, StepDefinition } from "../../src/Types.ts";
import type { TestHarness } from "./CreateTestHarness.ts";
import { CodexHarness } from "../../src/CodexHarness.ts";
import { ConveyorRunner, ReceiptRunError } from "../../src/Runner.ts";
import { createTestHarness } from "./CreateTestHarness.ts";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
