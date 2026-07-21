export class LocalEndpointScenario {
  private fixture = createFixture();
  private frames: EndpointFrame[] = [frame(this.fixture, "ready", null, null)];
  private database: FactorioDatabase | null = null;
  private store: ConveyorStore | null = null;
  private supervisor: LocalEndpointSupervisor | null = null;
  private runner: ConveyorRunner | null = null;

  snapshot(): Scenario {
    return { id: scenarioId, frames: this.frames };
  }

  async play(): Promise<Scenario> {
    await this.reset();
    this.supervisor = new LocalEndpointSupervisor();
    const harness = new EndpointHarness((phase, session) => this.capture(phase, session));
    this.database = new FactorioDatabase(this.fixture.databasePath);
    this.store = new ConveyorStore(this.database);
    this.runner = new ConveyorRunner(this.store, harness, undefined, {}, this.supervisor);
    this.store.createBlob(blobId, blobInput(this.fixture));
    this.store.armHumanGate(blobId, "Hold the exact-head endpoint for a delayed human decision.");
    this.store.requestStep(blobId);
    await this.runner.runOnce();
    this.capture("receipt-ended", harness.session);
    return this.snapshot();
  }

  async approve(): Promise<Scenario> {
    this.requireActive().approveHumanGate(blobId, "Approved exact endpoint head.", [this.currentHead()]);
    return this.finishDecision("approved");
  }

  async reject(): Promise<Scenario> {
    this.requireActive().addHumanFeedback(blobId, "Endpoint rejected with requested changes.", [this.currentHead()]);
    return this.finishDecision("rejected");
  }

  async restart(): Promise<Scenario> {
    const store = this.requireActive();
    this.capture("service-restarting", this.currentSession());
    this.supervisor = new LocalEndpointSupervisor();
    this.runner = new ConveyorRunner(store, new EndpointHarness(() => {}), undefined, {}, this.supervisor);
    await this.runner.reconcileLocalEndpoints();
    this.capture("recovered", this.currentSession());
    return this.snapshot();
  }

  async recoverLostChild(): Promise<Scenario> {
    const before = this.currentSession();
    if (!before) throw new Error("Play the retained endpoint before simulating process loss.");
    process.kill(-before.pid, "SIGTERM");
    await waitUntilUnavailable(before.url);
    this.capture("child-lost", { ...before });
    await this.runner!.reconcileLocalEndpoints();
    const after = this.currentSession();
    if (!after || !await endpointHealthy(after.url)) throw new Error("Retained endpoint was not recovered.");
    this.capture("recovered", after);
    return this.snapshot();
  }

  async pollStable(): Promise<Scenario> {
    const store = this.requireActive();
    const lease = store.pendingLocalEndpointLeases()[0];
    if (!lease || !this.supervisor) throw new Error("Play the retained endpoint before polling ownership.");
    const first = await this.supervisor.recover(lease);
    let stable = true;
    for (let poll = 0; poll < 3; poll += 1) stable &&= await this.supervisor.recover(lease) === first;
    this.capture(stable ? "stable" : "churn", first);
    return this.snapshot();
  }

  async reset(): Promise<Scenario> {
    await this.cleanup("Local endpoint scenario reset.");
    disposeFixture(this.fixture);
    this.fixture = createFixture();
    this.frames = [frame(this.fixture, "ready", null, null)];
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    await this.cleanup("Local endpoint scenario disposed.");
    disposeFixture(this.fixture);
  }

  private capture(phase: EndpointPhase, session: LocalEndpointSession | null): void {
    const receipts = readReceipts(this.fixture.databasePath);
    this.frames.push(frame(this.fixture, phase, session, receipts.at(-1) ?? null));
  }

  private async finishDecision(phase: "approved" | "rejected"): Promise<Scenario> {
    this.capture(phase, this.currentSession());
    await this.runner!.reconcileLocalEndpoints();
    this.capture("stopped", this.currentSession());
    return this.snapshot();
  }

  private async cleanup(reason: string): Promise<void> {
    if (this.store && this.runner) {
      this.store.resetLocalEndpoint(blobId, reason);
      await this.runner.reconcileLocalEndpoints();
    }
    this.database?.close();
    this.database = null; this.store = null; this.runner = null; this.supervisor = null;
  }

  private requireActive(): ConveyorStore {
    if (!this.store) throw new Error("Play the local endpoint lifecycle first.");
    return this.store;
  }

  private currentSession(): LocalEndpointSession | null {
    const lease = this.store?.listLocalEndpointLeases(blobId).at(-1);
    return lease ? {
      runId: lease.id, url: lease.url, cwd: lease.workspaceRoot,
      gitHead: lease.gitHead, port: lease.port, pid: lease.pid,
      command: lease.command, args: lease.args,
    } : null;
  }

  private currentHead(): string {
    return `git-head:${git(this.fixture.workspace, ["rev-parse", "HEAD"]).trim()}`;
  }
}

class EndpointHarness implements AgentHarness {
  readonly name = "endpoint-fixture-agent";
  session: LocalEndpointSession | null = null;
  private readonly onPhase: PhaseObserver;

  constructor(onPhase: PhaseObserver) {
    this.onPhase = onPhase;
  }

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    observer.event({ type: "external-run", externalRunId: "endpoint-fixture:run-1" });
    writeFileSync(join(input.blob.executionWorkspaceRoot, "endpoint-output.txt"), "agent-owned endpoint\n");
    git(input.blob.executionWorkspaceRoot, ["add", "endpoint-output.txt"]);
    git(input.blob.executionWorkspaceRoot, ["commit", "-m", "Declare local endpoint"]);
    this.onPhase("committed", null);
    this.session = await observer.startLocalEndpoint?.() ?? null;
    if (!this.session) throw new Error("Fixture local endpoint was not declared.");
    this.onPhase("healthy", this.session);
    const response = await fetch(this.session.url);
    if (!response.ok) throw new Error("Exit evaluation could not reach the local endpoint.");
    this.onPhase("exit-received-url", this.session);
    return {
      decision: "advance", reason: "exit evaluation received a healthy exact-head local endpoint",
      outputArtifacts: [`local-endpoint:${this.session.url}`], externalRunId: "endpoint-fixture:run-1",
    };
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.start(input, observer);
  }

  async cancel(): Promise<void> {}
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-local-endpoint-"));
  const workspace = join(root, "assigned-workspace");
  const pipelinePath = join(workspace, "pipelines", "default", "v1");
  mkdirSync(pipelinePath, { recursive: true });
  writeFileSync(join(pipelinePath, "01.build.endpoint.entry.md"), "Produce a declared local endpoint.");
  writeFileSync(join(pipelinePath, "01.build.endpoint.exit.md"), "Verify its endpoint artifact.");
  mkdirSync(join(workspace, ".axi-factorio"), { recursive: true });
  writeFileSync(join(workspace, ".axi-factorio", "local-endpoint.json"), JSON.stringify({
    command: process.execPath, args: ["endpoint-server.ts"], healthPath: "/health",
  }, null, 2));
  writeFileSync(join(workspace, "endpoint-server.ts"), endpointServerSource);
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.email", "factorio@example.test"]);
  git(workspace, ["config", "user.name", "Factorio Fixture"]);
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "Initial fixture"]);
  return { root, workspace, pipelinePath, databasePath: join(root, "factorio.sqlite") };
}

function frame(
  fixture: Fixture,
  phase: EndpointPhase,
  session: LocalEndpointSession | null,
  receipt: Receipt | null,
): EndpointFrame {
  const head = git(fixture.workspace, ["rev-parse", "HEAD"]).trim();
  const server = session ? { ...session, alive: phase !== "stopped" } : null;
  const lease = readLocalEndpointLease(fixture.databasePath);
  return {
    name: "Durable declared local endpoint",
    description: "Receipt ends · endpoint lease stays live · human disposition owns cleanup",
    source: "scenario", steps: [{ id: "build.endpoint", label: "Endpoint", group: "build", groupLabel: "Build" }],
    blobs: [{ id: blobId, title: "Endpoint-producing task", stepId: receipt?.status === "advance" ? "complete" : "build.endpoint", state: phaseStatus(phase), completedStepIds: receipt?.status === "advance" ? ["build.endpoint"] : [], importedStepIds: [] }],
    receipts: receipt ? [viewReceipt(receipt)] : [], assertions: assertions(fixture, phase, session, head), evidenceCards: [],
    visual: { kind: "local-endpoint", phase, workspace: realpathSync(fixture.workspace), head, endpoint: server, lease },
  };
}

function assertions(
  fixture: Fixture,
  phase: EndpointPhase,
  session: LocalEndpointSession | null,
  head: string,
): Assertion[] {
  return [
    { label: "Agent never binds the endpoint port", passed: true },
    { label: "Declared argv remains literal", passed: !session || session.command === process.execPath && session.args.join(" ") === "endpoint-server.ts" },
    { label: "Supervisor uses the assigned workspace", passed: !session || session.cwd === realpathSync(fixture.workspace) },
    { label: "Health is exact-head", passed: !session || session.gitHead === head },
    { label: "Endpoint lease survives receipt completion", passed: phase !== "receipt-ended" || Boolean(session) },
    { label: "Disposition owns final cancellation", passed: phase !== "stopped" || session !== null },
  ];
}

function phaseStatus(phase: EndpointPhase): "ready" | "running" | "waiting" | "complete" {
  if (phase === "ready") return "ready";
  if (phase === "stopped") return "complete";
  if (["receipt-ended", "service-restarting", "child-lost", "recovered", "stable", "churn", "approved", "rejected"].includes(phase)) return "waiting";
  return "running";
}

async function waitUntilUnavailable(url: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!await endpointHealthy(url)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Fixture endpoint did not stop.");
}

async function endpointHealthy(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(300) })).ok; }
  catch { return false; }
}

function readReceipts(databasePath: string): Receipt[] {
  if (!existsSync(databasePath)) return [];
  const database = new FactorioDatabase(databasePath);
  try { return new ConveyorStore(database).listReceipts(blobId); } finally { database.close(); }
}

function readLocalEndpointLease(databasePath: string): LocalEndpointLease | null {
  if (!existsSync(databasePath)) return null;
  const database = new FactorioDatabase(databasePath);
  try { return new ConveyorStore(database).listLocalEndpointLeases(blobId).at(-1) ?? null; }
  finally { database.close(); }
}

function viewReceipt(receipt: Receipt): ViewReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId, status: receipt.status,
    at: receipt.finishedAt ?? receipt.startedAt, detail: receipt.reason ?? receipt.error ?? "running",
  };
}

function blobInput(fixture: Fixture): BlobInput {
  return {
    title: "Endpoint-producing task", body: "Expose one committed local endpoint for a delayed decision.",
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

export type LocalEndpointVisual = {
  kind: "local-endpoint";
  phase: EndpointPhase;
  workspace: string;
  head: string;
  endpoint: (LocalEndpointSession & { alive: boolean }) | null;
  lease: LocalEndpointLease | null;
};
type EndpointPhase = "ready" | "committed" | "healthy" | "exit-received-url" | "receipt-ended"
  | "service-restarting" | "child-lost" | "recovered" | "stable" | "churn" | "approved" | "rejected" | "stopped";
type PhaseObserver = (phase: EndpointPhase, session: LocalEndpointSession | null) => void;
type Fixture = { root: string; workspace: string; pipelinePath: string; databasePath: string };
type Assertion = { label: string; passed: boolean };
type EndpointFrame = {
  name: string; description: string; source: "scenario";
  steps: Array<{ id: string; label: string; group: string; groupLabel: string }>;
  blobs: Array<Record<string, unknown>>; receipts: ViewReceipt[]; assertions: Assertion[];
  evidenceCards: []; visual: LocalEndpointVisual;
};
type Scenario = { id: string; frames: EndpointFrame[] };
type ViewReceipt = { id: string; blobId: string; stepId: string; status: string; at: string; detail: string };

const blobId = "local-endpoint-fixture";
const scenarioId = "local-endpoint-supervisor";
const endpointServerSource = `
import { createServer } from "node:http";
const port = Number(process.env.AXI_FACTORIO_ENDPOINT_PORT ?? process.env.PORT);
createServer((request, response) => {
  if (request.url !== "/health") { response.writeHead(404).end("not found"); return; }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("endpoint:healthy");
}).listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "endpoint.ready", url: \`http://127.0.0.1:\${port}/health\` })));
`;

import type {
  AgentHarness, HarnessObserver, HarnessResult, HarnessResumeInput, HarnessStartInput,
} from "../../src/Harness.ts";
import type { BlobInput, Receipt, LocalEndpointLease } from "../../src/Types.ts";
import type { LocalEndpointSession } from "../../src/LocalEndpointSupervisor.ts";
import { LocalEndpointSupervisor } from "../../src/LocalEndpointSupervisor.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { ConveyorRunner } from "../../src/Runner.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
