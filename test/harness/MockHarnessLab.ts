export class MockHarnessLab {
  private root = "";
  private databasePath = "";
  private database!: FactorioDatabase;
  private store!: ConveyorStore;
  private harness!: MockAgentHarness;
  private runner!: ConveyorRunner;
  private steps: StepDefinition[] = [];
  private activeWork: Promise<void> | null = null;

  constructor() {
    this.reset();
  }

  reset(): LabSnapshot {
    this.disposeCurrent();
    this.root = mkdtempSync(join(tmpdir(), "axi-factorio-mock-lab-"));
    const pipelinePath = join(this.root, "pipeline");
    cpSync(templatePath, pipelinePath, { recursive: true });
    initializeGit(this.root);
    this.databasePath = join(this.root, "factorio.sqlite");
    this.open(pipelinePath);
    this.store.createBlob(blobId, {
      title: "Mock harness laboratory", body: "Exercise the production conveyor.",
      cwd: this.root, pipelinePath, inputArtifacts: ["request:mock-lab"],
    });
    return this.snapshot("Reset a fresh temporary SQLite laboratory.");
  }

  async action(action: LabAction): Promise<LabSnapshot> {
    if (action === "reset") return this.reset();
    if (action === "play") {
      this.store.requestContinuous(blobId);
      this.startWork();
    } else if (action === "step") {
      this.store.requestStep(blobId);
      await this.startWork();
    } else if (action === "stop") {
      this.store.requestStop(blobId);
      await this.activeWork;
    } else if (action === "retry") {
      this.store.retryBlob(blobId);
      await this.startWork();
    } else if (action === "feedback") {
      this.store.addHumanFeedback(blobId, "Please revise and show the result.", ["voice:mock-1"]);
      await this.startWork();
    } else if (action === "approve") {
      this.store.approveHumanGate(blobId, "Approved at exact mock head.", ["head:mock-approved"]);
      await this.startWork();
    } else if (action === "fail") {
      this.harness.failNext();
      if (this.store.getBlob(blobId)?.paused) this.store.retryBlob(blobId);
      else this.store.requestContinuous(blobId);
      await this.startWork();
    } else if (action === "restart") {
      this.restart();
    }
    return this.snapshot(actionDescriptions[action]);
  }

  async waitForIdle(): Promise<LabSnapshot> {
    await this.activeWork;
    return this.snapshot("The requested execution is idle.");
  }

  snapshot(message = "Ready for an action."): LabSnapshot {
    const blob = this.store.getBlob(blobId)!;
    const receipts = this.store.listReceipts(blobId);
    const events = this.store.listExecutionEvents(blobId);
    return {
      name: "Deterministic mock harness",
      description: message,
      steps: this.steps.map((step) => ({ id: step.id, label: titleCase(step.id.split(".").at(-1)!) })),
      blob: {
        id: blob.id, title: blob.title, state: blob.state, paused: blob.paused,
        runRequested: blob.runRequested, executionMode: blob.executionMode,
      },
      receipts,
      events,
      humanInputs: this.store.listHumanInputs(blobId),
      latestExternalRunId: receipts.at(-1)?.externalRunId ?? null,
      assertions: labAssertions(blob.state, receipts),
    };
  }

  dispose(): void {
    this.disposeCurrent();
    if (this.root) rmSync(this.root, { recursive: true, force: true });
  }

  private open(pipelinePath: string): void {
    this.database = new FactorioDatabase(this.databasePath);
    this.store = new ConveyorStore(this.database);
    this.harness = new MockAgentHarness(750);
    this.runner = new ConveyorRunner(this.store, this.harness);
    this.steps = discoverPipeline(pipelinePath);
  }

  private restart(): void {
    const pipelinePath = this.store.getBlob(blobId)!.pipelinePath;
    this.database.close();
    this.open(pipelinePath);
  }

  private startWork(): Promise<void> {
    if (this.activeWork) return this.activeWork;
    const work = this.drain();
    const tracked = work.finally(() => {
      if (this.activeWork === tracked) this.activeWork = null;
    });
    this.activeWork = tracked;
    return tracked;
  }

  private async drain(): Promise<void> {
    while (this.store.getBlob(blobId)?.runRequested && await this.runSafely()) {}
  }

  private async runSafely(): Promise<boolean> {
    const blob = this.store.getBlob(blobId);
    if (blob?.state === "review.human" && blob.humanGateStepId !== "review.human") {
      this.store.armHumanGate(blobId, "Approval is required at review.human.");
    }
    try {
      return await new ConveyorService(this.store, this.runner).runOnce(new AbortController().signal);
    } catch (error) {
      if (!(error instanceof ReceiptRunError)) throw error;
      return false;
    }
  }

  private disposeCurrent(): void {
    try { this.database?.close(); } catch {}
  }
}

function labAssertions(state: string, receipts: Receipt[]): LabAssertion[] {
  const review = receipts.filter((receipt) => receipt.stepId === "review.human");
  return [
    { label: "Receipts are persisted by the production store", passed: receipts.every((receipt) => receipt.id) },
    {
      label: "Same-step review resumes the same external run",
      passed: review.length < 2 || new Set(review.map((receipt) =>
        receipt.externalRunId ?? receipt.continuationThreadId)).size === 1,
    },
    {
      label: "Completed only after all three stages advance",
      passed: state !== "complete" || receipts.filter((receipt) => receipt.status === "advance").length === 3,
    },
  ];
}

function initializeGit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "factorio@test.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Factorio Mock Lab"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "mock harness lab"], { cwd: root });
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const blobId = "mock-lab-blob";
const templatePath = join(dirname(fileURLToPath(import.meta.url)), "mock");
const actionDescriptions: Record<LabAction, string> = {
  reset: "Reset a fresh temporary SQLite laboratory.",
  play: "Play ran continuously until a human gate, failure, or completion.",
  step: "Step ran exactly one transition.",
  stop: "Stop cleared durable queued execution after the active transition.",
  retry: "Retry resumed the paused current step.",
  feedback: "Human feedback was appended and resumed the same current-step run.",
  approve: "Approval evidence was appended and continuous execution resumed.",
  fail: "The deterministic harness failed and the conveyor halted.",
  restart: "The database and production runner were reopened from disk.",
};

export type LabAction = "reset" | "play" | "step" | "stop" | "retry" | "feedback" | "approve" | "fail" | "restart";
export type LabAssertion = { label: string; passed: boolean };
export type LabSnapshot = {
  name: string;
  description: string;
  steps: Array<{ id: string; label: string }>;
  blob: Pick<Blob, "id" | "title" | "state" | "paused" | "runRequested" | "executionMode">;
  receipts: Receipt[];
  events: ExecutionEvent[];
  humanInputs: HumanInput[];
  latestExternalRunId: string | null;
  assertions: LabAssertion[];
};

import type { Blob, ExecutionEvent, HumanInput, Receipt, StepDefinition } from "../../src/Types.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { ConveyorRunner, ReceiptRunError } from "../../src/Runner.ts";
import { ConveyorService } from "../../src/Service.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { discoverPipeline } from "../../src/Pipeline.ts";
import { MockAgentHarness } from "./MockHarness.ts";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
