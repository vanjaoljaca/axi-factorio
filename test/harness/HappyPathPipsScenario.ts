export class HappyPathPipsScenario {
  private root = "";
  private pipelinePath = "";
  private database!: FactorioDatabase;
  private store!: ConveyorStore;
  private harness!: SyntheticPipHarness;
  private runner!: ConveyorRunner;

  constructor() {
    this.reset();
  }

  reset(): HappyPathScenario {
    this.dispose();
    this.openFixture();
    return this.snapshot();
  }

  async play(): Promise<HappyPathScenario> {
    const blob = this.store.getBlob(blobId)!;
    if (blob.state === "complete") return this.snapshot();
    if (blob.state === "human.choose") this.chooseOrRerun();
    else if (blob.state === "human.accept") this.accept();
    else await this.runWorkPip();
    return this.snapshot();
  }

  dispose(): void {
    this.database?.close();
    if (this.root) rmSync(this.root, { recursive: true, force: true });
  }

  snapshot(): HappyPathScenario {
    const blob = this.store.getBlob(blobId)!;
    const receipts = this.store.listReceipts(blobId);
    const inputs = this.store.listHumanInputs(blobId);
    return {
      id: scenarioId,
      frames: [{
        name: "Happy-path pips",
        description: description(blob, inputs),
        source: "scenario",
        steps: discoverPipeline(this.pipelinePath).map(viewStep),
        blobs: [{ id: blob.id, title: blob.title, state: viewState(blob), stepId: blob.state }],
        receipts: receipts.map(viewReceipt),
        assertions: assertions(receipts, this.harness.calls),
        visual: {
          kind: "happy-pips", phase: phase(blob, inputs),
          artifacts: this.artifacts(), feedback: inputs.find((input) => input.kind === "feedback")?.text ?? null,
          harnessCalls: this.harness.calls.length,
        },
      }],
    };
  }

  private openFixture(): void {
    const fixture = createPipeline(stepIds);
    this.root = fixture.root;
    this.pipelinePath = fixture.pipelinePath;
    writeStep(this.pipelinePath, 0, stepIds[0], "Explore the information structure.", "");
    writeStep(this.pipelinePath, 1, stepIds[1], "Explore a calm presentation direction.", "");
    writeStep(this.pipelinePath, 2, stepIds[2], "", "");
    writeStep(this.pipelinePath, 3, stepIds[3], "Merge the accepted exploration artifacts.", "");
    writeStep(this.pipelinePath, 4, stepIds[4], "", "");
    commitAll(this.root, "synthetic happy-path pips");
    this.database = new FactorioDatabase(join(this.root, "factorio.sqlite"));
    this.store = new ConveyorStore(this.database);
    this.harness = new SyntheticPipHarness(this.root);
    this.runner = new ConveyorRunner(this.store, this.harness);
    this.store.createBlob(blobId, {
      title: "Synthetic status dashboard", body: "Explore two directions, choose, then merge.",
      cwd: this.root, pipelinePath: this.pipelinePath, inputArtifacts: ["request:synthetic-dashboard"],
    });
  }

  private async runWorkPip(): Promise<void> {
    this.store.requestStep(blobId);
    await this.runner.runBlob(blobId);
  }

  private chooseOrRerun(): void {
    const feedback = this.store.listHumanInputs(blobId).find((input) => input.kind === "feedback");
    if (feedback) {
      this.store.approveHumanGate(blobId, "Use the quieter direction.", ["human:chosen"], false);
      return;
    }
    const steps = discoverPipeline(this.pipelinePath);
    this.store.addHumanFeedbackForRerun(
      blobId, requireStep(steps, "codex.explore-presentation"), steps,
      "Reduce density and make the hierarchy calmer.", ["human:direction"], false,
    );
  }

  private accept(): void {
    this.store.approveHumanGate(blobId, "Synthetic demo accepted.", ["human:accepted-demo"], false);
  }

  private artifacts(): ArtifactPreview[] {
    return artifactFiles.map(({ id, label, file }) => {
      const path = join(this.root, "artifacts", file);
      return { id, label, present: existsSync(path), content: existsSync(path) ? readFileSync(path, "utf8") : "" };
    });
  }
}

class SyntheticPipHarness implements AgentHarness {
  readonly name = "synthetic-happy-path";
  readonly calls: HarnessStartInput[] = [];
  private presentationAttempt = 0;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    this.calls.push(input);
    observer.event({ type: "external-run", externalRunId: `synthetic:${this.calls.length}` });
    return this.execute(input);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.start(input, observer);
  }

  async cancel(): Promise<void> {}

  private execute(input: HarnessStartInput): HarnessResult {
    if (input.step.id === "codex.explore-structure") return this.write("structure.json", structureArtifact);
    if (input.step.id === "codex.explore-presentation") {
      this.presentationAttempt += 1;
      const content = this.presentationAttempt === 1 ? denseArtifact : calmArtifact;
      return this.write("presentation.json", content, `artifact:presentation-v${this.presentationAttempt}`);
    }
    return this.write("merged-demo.json", mergedArtifact, "artifact:merged-demo");
  }

  private write(file: string, content: object, artifact = `artifact:${file.replace(/\.json$/u, "")}`): HarnessResult {
    const directory = join(this.root, "artifacts");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, file), JSON.stringify(content));
    return { decision: "advance", reason: "Synthetic pip completed.", outputArtifacts: [artifact], externalRunId: null };
  }
}

function description(blob: Blob, inputs: HumanInput[]): string {
  if (blob.state === "complete") return "Fan-out, targeted feedback, fan-in, and both human approvals completed.";
  if (blob.state === "human.choose") return "Human choice pip · inspect the exploration before approving or rerunning.";
  if (blob.state === "human.accept") return "Human acceptance pip · the merged synthetic demo is ready.";
  if (inputs.some((input) => input.kind === "feedback") && blob.state === "codex.explore-presentation") {
    return "Targeted feedback rewound only the presentation pip; Play reruns it once.";
  }
  return `Ready to run ${blob.state}.`;
}

function phase(blob: Blob, inputs: HumanInput[]): HappyPathPhase {
  if (blob.state === "complete") return "complete";
  if (blob.state === "human.accept") return "accept";
  if (blob.state === "human.choose") return inputs.some((input) => input.kind === "feedback") ? "revised" : "choose";
  if (blob.state === "codex.merge") return "merge";
  if (inputs.some((input) => input.kind === "feedback")) return "feedback";
  return blob.state === "codex.explore-presentation" ? "presentation" : "structure";
}

function assertions(receipts: Receipt[], calls: HarnessStartInput[]): Assertion[] {
  const human = receipts.filter((receipt) => receipt.executionKind === "human");
  const merged = receipts.find((receipt) => receipt.stepId === "codex.merge");
  return [
    { label: "Human pips allocate no harness session", passed: calls.every((call) => call.step.id.startsWith("codex.")) },
    { label: "Human approvals are append-only receipts", passed: human.every((receipt) => receipt.adapter === "human-approval") },
    { label: "Fan-in uses the valid revised presentation", passed: !merged || merged.inputArtifacts.includes("artifact:presentation-v2") },
  ];
}

function viewStep(step: StepDefinition): ViewStep {
  return { id: step.id, label: step.id.split(".").at(-1)?.replaceAll("-", " ") ?? step.id };
}

function viewReceipt(receipt: Receipt): ViewReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId,
    status: receipt.invalidatedAt ? "invalidated" : receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.reason ?? `attempt ${receipt.attempt}`,
  };
}

function viewState(blob: Blob): string {
  if (blob.state === "complete") return "complete";
  return blob.paused ? "waiting" : "ready";
}

export type HappyPathPhase = "structure" | "presentation" | "choose" | "feedback" | "revised" | "merge" | "accept" | "complete";
export type HappyPathVisual = {
  kind: "happy-pips";
  phase: HappyPathPhase;
  artifacts: ArtifactPreview[];
  feedback: string | null;
  harnessCalls: number;
};
type ArtifactPreview = { id: string; label: string; present: boolean; content: string };
type Assertion = { label: string; passed: boolean };
type ViewStep = { id: string; label: string };
type ViewReceipt = { id: string; blobId: string; stepId: string; status: string; at: string; detail: string };
type HappyPathScenario = {
  id: string;
  frames: Array<{
    name: string; description: string; source: "scenario"; steps: ViewStep[];
    blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
    receipts: ViewReceipt[]; assertions: Assertion[]; visual: HappyPathVisual;
  }>;
};

const scenarioId = "happy-path-pips";
const blobId = "synthetic-happy-pips";
const stepIds = [
  "codex.explore-structure", "codex.explore-presentation", "human.choose", "codex.merge", "human.accept",
];
const artifactFiles = [
  { id: "structure", label: "Structure", file: "structure.json" },
  { id: "presentation", label: "Presentation", file: "presentation.json" },
  { id: "merged", label: "Merged demo", file: "merged-demo.json" },
];
const structureArtifact = { eyebrow: "This week", title: "Delivery health", sections: ["Ready", "Moving", "Needs a decision"] };
const denseArtifact = { density: "busy", columns: 4, accent: "high", note: "Everything competes for attention" };
const calmArtifact = { density: "calm", columns: 2, accent: "focused", note: "One primary signal, quiet supporting facts" };
const mergedArtifact = { title: "Delivery health", primary: "12 items moving", secondary: ["8 ready", "3 active", "1 awaiting decision"] };

import type { AgentHarness, HarnessObserver, HarnessResult, HarnessResumeInput, HarnessStartInput } from "../../src/Harness.ts";
import type { Blob, HumanInput, Receipt, StepDefinition } from "../../src/Types.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { discoverPipeline, requireStep } from "../../src/Pipeline.ts";
import { ConveyorRunner } from "../../src/Runner.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { commitAll, createPipeline, writeStep } from "../../tests/Fixtures.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
