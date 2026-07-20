export async function runBlobWorkspaceRelocationScenario(): Promise<BlobWorkspaceRelocationResult> {
  const fixture = createFixture();
  try {
    return await fixture.run();
  } finally {
    fixture.dispose();
  }
}

function createFixture(): RelocationFixture {
  const base = createTestHarness();
  const root = dirname(base.pipelinePath);
  const rootA = join(root, "workspace-a");
  const rootB = join(root, "workspace-b");
  mkdirSync(rootA);
  mkdirSync(rootB);
  return new RelocationFixture(base, realpathSync(rootA), realpathSync(rootB));
}

class RelocationFixture {
  private readonly base: TestHarness;
  private readonly rootA: string;
  private readonly rootB: string;
  private readonly harness = new CwdRecordingHarness();
  private readonly runner: ConveyorRunner;

  constructor(
    base: TestHarness,
    rootA: string,
    rootB: string,
  ) {
    this.base = base;
    this.rootA = rootA;
    this.rootB = rootB;
    this.runner = new ConveyorRunner(base.store, this.harness);
  }

  async run(): Promise<BlobWorkspaceRelocationResult> {
    this.createAtRootA();
    await this.step();
    const first = this.base.store.listReceipts(blobId)[0];
    const relocation = this.relocateThroughCli();
    await this.step();
    return this.result(first, relocation);
  }

  dispose(): void {
    this.base.dispose();
  }

  private createAtRootA(): void {
    this.base.store.createProject(projectId, {
      name: "Relocation proof",
      root: this.rootA,
      pipelineRoot: dirname(this.base.pipelinePath),
      defaultPipeline: this.base.pipelinePath,
    });
    this.base.store.createBlob(blobId, {
      title: "Move durable work",
      body: "Keep one blob and its receipt history while moving its workspace.",
      cwd: this.rootA,
      projectId,
      pipelineId: "default/v1",
      pipelinePath: this.base.pipelinePath,
      inputArtifacts: [],
    });
  }

  private async step(): Promise<void> {
    this.base.store.requestStep(blobId);
    await this.runner.runOnce();
  }

  private relocateThroughCli(): CliResult {
    return spawnSync(process.execPath, [
      "--disable-warning=ExperimentalWarning", cliPath,
      "--db", databasePath(this.base), "relocate", blobId, "--root", this.rootB,
      "--evidence", "scenario:root-b", "--json",
    ], { encoding: "utf8" });
  }

  private result(first: Receipt, relocation: CliResult): BlobWorkspaceRelocationResult {
    const blob = this.base.store.getBlob(blobId)!;
    const project = this.base.store.getProject(projectId)!;
    const receipts = this.base.store.listReceipts(blobId);
    const history = this.base.store.listWorkspaceRelocations(blobId);
    const observedPath = this.harness.executedCwds[1] ?? "(second receipt missing)";
    return {
      id: scenarioId,
      frames: [frame(this.rootA, this.rootB, first, receipts, relocation, observedPath, history)],
      oldCwd: this.rootA,
      newCwd: blob.cwd,
      projectRoot: project.root,
      nextReceiptCwd: observedPath,
      receipts,
      history,
      cliStatus: relocation.status,
    };
  }
}

class CwdRecordingHarness implements AgentHarness {
  readonly name = "workspace-relocation-scenario";
  readonly model = "deterministic-cwd-recorder";
  readonly executedCwds: string[] = [];

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.executedCwds.push(input.blob.cwd);
    writeFileSync(join(input.blob.cwd, `receipt-${input.step.id}.txt`), input.blob.cwd);
    const externalRunId = `relocation:${input.runId}`;
    observer.event({ type: "external-run", externalRunId });
    return {
      decision: "advance",
      reason: `Executed in ${input.blob.cwd}`,
      outputArtifacts: [`workspace:${input.blob.cwd}`],
      externalRunId,
    };
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.start(input, observer);
  }

  async cancel(): Promise<void> {}
}

function frame(
  rootA: string,
  rootB: string,
  first: Receipt,
  receipts: Receipt[],
  relocation: CliResult,
  nextReceiptCwd: string,
  history: WorkspaceRelocation[],
): WorkbenchFrame {
  const relocated = nextReceiptCwd === rootB;
  return {
    name: "Deliberate blob workspace relocation",
    description: `Expected next receipt in ${rootB}; observed ${nextReceiptCwd}. Real CLI → Store → Runner path.`,
    source: "scenario",
    steps: [{ id: "g1.first", label: "First" }, { id: "g2.second", label: "Second" }],
    blobs: [{ id: blobId, title: "Move durable work", state: relocated ? "complete" : "failed", stepId: "complete" }],
    receipts: receipts.map(viewReceipt),
    assertions: [
      { label: "CLI relocation succeeds deliberately", passed: relocation.status === 0 },
      { label: "Old cwd is retained in durable relocation provenance", passed: history[0]?.oldCwd === rootA },
      { label: "Project and selected blob move to root B", passed: history[0]?.newCwd === rootB },
      { label: "Next receipt executes only in root B", passed: relocated },
      { label: "One blob retains both receipts", passed: first.blobId === blobId && receipts.length === 2 },
    ],
    evidenceCards: [
      { label: "Old cwd", value: rootA },
      { label: "New cwd", value: history[0]?.newCwd ?? rootA },
      {
        label: "Relocate CLI",
        value: `axi-factorio relocate ${blobId} --root ${rootB} --evidence scenario:root-b\nexit ${relocation.status}`,
      },
      { label: "Next receipt path", value: nextReceiptCwd },
      { label: "Receipt history", value: receipts.map((receipt) => `#${receipt.attempt} ${receipt.stepId} · ${receipt.reason}`).join("\n") },
      { label: "Durable provenance", value: history.length ? JSON.stringify(history[0], null, 2) : "(missing)" },
    ],
  };
}

function viewReceipt(receipt: Receipt): WorkbenchReceipt {
  return {
    id: receipt.id,
    blobId: receipt.blobId,
    stepId: receipt.stepId,
    status: receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.reason ?? receipt.error ?? `attempt ${receipt.attempt}`,
  };
}

function databasePath(base: TestHarness): string {
  const row = base.database.connection.prepare("PRAGMA database_list").get() as { file: string };
  return row.file;
}

const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const scenarioId = "blob-workspace-relocation";
const projectId = "relocation-project";
const blobId = "relocation-blob";

export type BlobWorkspaceRelocationResult = {
  id: string;
  frames: WorkbenchFrame[];
  oldCwd: string;
  newCwd: string;
  projectRoot: string;
  nextReceiptCwd: string;
  receipts: Receipt[];
  history: WorkspaceRelocation[];
  cliStatus: number | null;
};
type CliResult = ReturnType<typeof spawnSync>;
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: WorkbenchReceipt[];
  assertions: Array<{ label: string; passed: boolean }>;
  evidenceCards: Array<{ label: string; value: string }>;
};
type WorkbenchReceipt = {
  id: string;
  blobId: string;
  stepId: string;
  status: string;
  at: string;
  detail: string;
};

import type { AgentHarness, HarnessObserver, HarnessResult, HarnessResumeInput, HarnessStartInput } from "../../src/Harness.ts";
import type { Receipt, WorkspaceRelocation } from "../../src/Types.ts";
import type { TestHarness } from "./CreateTestHarness.ts";
import { ConveyorRunner } from "../../src/Runner.ts";
import { createTestHarness } from "./CreateTestHarness.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
