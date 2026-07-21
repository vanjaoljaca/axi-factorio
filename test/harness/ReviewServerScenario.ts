export class ReviewServerScenario {
  private fixture = createFixture();
  private frames: ReviewFrame[] = [frame(this.fixture, "ready", null, null)];

  snapshot(): Scenario {
    return { id: scenarioId, frames: this.frames };
  }

  async play(): Promise<Scenario> {
    this.reset();
    const supervisor = new ReviewServerSupervisor();
    const harness = new ReviewHarness((phase, session) => this.capture(phase, session));
    const database = new FactorioDatabase(this.fixture.databasePath);
    const store = new ConveyorStore(database);
    store.createBlob(blobId, blobInput(this.fixture));
    store.requestStep(blobId);
    await new ConveyorRunner(store, harness, undefined, {}, supervisor).runOnce();
    this.capture("stopped", harness.session);
    database.close();
    return this.snapshot();
  }

  reset(): Scenario {
    disposeFixture(this.fixture);
    this.fixture = createFixture();
    this.frames = [frame(this.fixture, "ready", null, null)];
    return this.snapshot();
  }

  dispose(): void {
    disposeFixture(this.fixture);
  }

  private capture(phase: ReviewPhase, session: ReviewServerSession | null): void {
    const receipts = readReceipts(this.fixture.databasePath);
    this.frames.push(frame(this.fixture, phase, session, receipts.at(-1) ?? null));
  }
}

class ReviewHarness implements AgentHarness {
  readonly name = "review-fixture-agent";
  session: ReviewServerSession | null = null;
  private readonly onPhase: PhaseObserver;

  constructor(onPhase: PhaseObserver) {
    this.onPhase = onPhase;
  }

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    observer.event({ type: "external-run", externalRunId: "review-fixture:run-1" });
    writeFileSync(join(input.blob.executionWorkspaceRoot, "workbench-output.txt"), "agent-owned workbench\n");
    git(input.blob.executionWorkspaceRoot, ["add", "workbench-output.txt"]);
    git(input.blob.executionWorkspaceRoot, ["commit", "-m", "Build app workbench"]);
    this.onPhase("committed", null);
    this.session = await observer.startReviewServer?.() ?? null;
    if (!this.session) throw new Error("Fixture review server was not declared.");
    this.onPhase("healthy", this.session);
    const response = await fetch(this.session.url);
    if (!response.ok) throw new Error("Exit evaluation could not reach the review server.");
    this.onPhase("exit-received-url", this.session);
    return {
      decision: "advance", reason: "exit evaluation received a healthy exact-head review URL",
      outputArtifacts: [`review-server:${this.session.url}`], externalRunId: "review-fixture:run-1",
    };
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.start(input, observer);
  }

  async cancel(): Promise<void> {}
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-review-server-"));
  const workspace = join(root, "assigned-workspace");
  const pipelinePath = join(workspace, "pipelines", "default", "v1");
  mkdirSync(pipelinePath, { recursive: true });
  writeFileSync(join(pipelinePath, "01.build.review.entry.md"), "Commit the app-owned workbench.");
  writeFileSync(join(pipelinePath, "01.build.review.exit.md"), "Verify the local review URL.");
  writeFileSync(join(workspace, "package.json"), JSON.stringify({
    private: true, scripts: { workbench: "node review-server.ts" },
  }, null, 2));
  writeFileSync(join(workspace, "review-server.ts"), reviewServerSource);
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.email", "factorio@example.test"]);
  git(workspace, ["config", "user.name", "Factorio Fixture"]);
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "Initial fixture"]);
  return { root, workspace, pipelinePath, databasePath: join(root, "factorio.sqlite") };
}

function frame(
  fixture: Fixture,
  phase: ReviewPhase,
  session: ReviewServerSession | null,
  receipt: Receipt | null,
): ReviewFrame {
  const head = git(fixture.workspace, ["rev-parse", "HEAD"]).trim();
  const server = session ? { ...session, alive: phase !== "stopped" } : null;
  return {
    name: "Factorio-owned local review server",
    description: "Agent commits · Factorio launches · exit receives URL · Factorio stops",
    source: "scenario", steps: [{ id: "build.review", label: "Review", group: "build", groupLabel: "Build" }],
    blobs: [{ id: blobId, title: "App workbench review", stepId: receipt?.status === "advance" ? "complete" : "build.review", status: phaseStatus(phase), completedStepIds: receipt?.status === "advance" ? ["build.review"] : [], importedStepIds: [] }],
    receipts: receipt ? [viewReceipt(receipt)] : [], assertions: assertions(fixture, phase, session, head), evidenceCards: [],
    visual: { kind: "review-server", phase, workspace: realpathSync(fixture.workspace), head, server },
  };
}

function assertions(
  fixture: Fixture,
  phase: ReviewPhase,
  session: ReviewServerSession | null,
  head: string,
): Assertion[] {
  return [
    { label: "Agent never binds the review port", passed: true },
    { label: "Safe npm argv is fixed", passed: !session || session.command === "npm" && session.args.join(" ") === "run workbench" },
    { label: "Supervisor uses the assigned workspace", passed: !session || session.cwd === realpathSync(fixture.workspace) },
    { label: "Health is exact-head", passed: !session || session.gitHead === head },
    { label: "Supervisor owns final cancellation", passed: phase !== "stopped" || session !== null },
  ];
}

function phaseStatus(phase: ReviewPhase): "ready" | "running" | "complete" {
  if (phase === "ready") return "ready";
  if (phase === "stopped") return "complete";
  return "running";
}

function readReceipts(databasePath: string): Receipt[] {
  if (!existsSync(databasePath)) return [];
  const database = new FactorioDatabase(databasePath);
  try { return new ConveyorStore(database).listReceipts(blobId); } finally { database.close(); }
}

function viewReceipt(receipt: Receipt): ViewReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId, status: receipt.status,
    at: receipt.finishedAt ?? receipt.startedAt, detail: receipt.reason ?? receipt.error ?? "running",
  };
}

function blobInput(fixture: Fixture): BlobInput {
  return {
    title: "App workbench review", body: "Expose the committed app workbench for review.",
    cwd: fixture.workspace, executionWorkspaceRoot: fixture.workspace,
    pipelineId: "default/v1", pipelinePath: fixture.pipelinePath, inputArtifacts: [],
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function disposeFixture(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

export type ReviewServerVisual = {
  kind: "review-server";
  phase: ReviewPhase;
  workspace: string;
  head: string;
  server: (ReviewServerSession & { alive: boolean }) | null;
};
type ReviewPhase = "ready" | "committed" | "healthy" | "exit-received-url" | "stopped";
type PhaseObserver = (phase: ReviewPhase, session: ReviewServerSession | null) => void;
type Fixture = { root: string; workspace: string; pipelinePath: string; databasePath: string };
type Assertion = { label: string; passed: boolean };
type ReviewFrame = {
  name: string; description: string; source: "scenario";
  steps: Array<{ id: string; label: string; group: string; groupLabel: string }>;
  blobs: Array<Record<string, unknown>>; receipts: ViewReceipt[]; assertions: Assertion[];
  evidenceCards: []; visual: ReviewServerVisual;
};
type Scenario = { id: string; frames: ReviewFrame[] };
type ViewReceipt = { id: string; blobId: string; stepId: string; status: string; at: string; detail: string };

const blobId = "review-server-fixture";
const scenarioId = "review-server-supervisor";
const reviewServerSource = `
import { createServer } from "node:http";
const port = Number(process.env.AXI_FACTORIO_REVIEW_PORT ?? process.env.PORT);
createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("fixture:healthy");
}).listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "review.ready", url: \`http://127.0.0.1:\${port}/\` })));
`;

import type {
  AgentHarness, HarnessObserver, HarnessResult, HarnessResumeInput, HarnessStartInput,
} from "../../src/Harness.ts";
import type { BlobInput, Receipt } from "../../src/Types.ts";
import type { ReviewServerSession } from "../../src/ReviewServerSupervisor.ts";
import { ReviewServerSupervisor } from "../../src/ReviewServerSupervisor.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { ConveyorRunner } from "../../src/Runner.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
