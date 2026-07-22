type ViewStep = { id: string; label: string };
type ViewBlob = { id: string; title: string; state: string; stepId: string | null };
type ViewReceipt = { id: string; blobId: string; stepId: string; status: string; at: string; detail: string };
type ViewSnapshot = {
  name: string;
  description: string;
  source: "scenario" | "database";
  steps: ViewStep[];
  blobs: ViewBlob[];
  receipts: ViewReceipt[];
  assertions: { label: string; passed: boolean }[];
  evidenceCards?: { label: string; value: string }[];
  visual?: LiveExecutionVisual | ViewerResilienceVisual | CursorActionVisual | LocalEndpointVisual | OverviewBoundaryVisual | ProjectRemovalVisual | AggregatePollingVisual | ActiveProjectsVisual | AxiValidationVisual | ServiceRecoveryVisual;
};
type Scenario = { id: string; frames: ViewSnapshot[] };
type LiveExecutionVisual = {
  kind: "live-execution";
  phase: "ready" | "queued" | "running" | "retry" | "advanced" | "complete" | "failed";
  executionOverviewHtml: string;
  timeline: { id: number; label: string; at: string }[];
  playEnabled: boolean;
};
type ViewerResilienceVisual = {
  kind: "viewer-resilience";
  projects: Array<{
    id: string;
    name: string;
    taskCount: number;
    pipeline: string | null;
    issue: { summary: string; detail: string } | null;
  }>;
};
type CursorActionVisual = {
  kind: "cursor-action";
  rows: Array<{
    id: string;
    title: string;
    root: string;
    workspaceKind: string;
    action: { enabled: boolean; explanation: string };
    triggerHtml: string;
  }>;
  lastResult: string;
  calls: number;
  menuHtml: string;
  openerLabel: string;
};
type LocalEndpointVisual = {
  kind: "local-endpoint";
  phase: "ready" | "committed" | "startup-timeout" | "healthy" | "exit-received-url" | "receipt-ended"
    | "service-restarting" | "child-lost" | "recovered" | "stable" | "churn"
    | "approved" | "rejected" | "stopped";
  workspace: string;
  head: string;
  endpoint: { url: string; cwd: string; gitHead: string; pid: number; command: string; args: string[]; alive: boolean } | null;
  lease: { ownership: string; desiredState: string; observedState: string; terminalReason: string | null } | null;
};
type OverviewBoundaryVisual = {
  kind: "overview-boundary";
  phase: "leaked" | "clean";
  diagnosticHtml: string;
};
type ProjectRemovalVisual = import("../test/harness/ProjectRemovalScenario.ts").ProjectRemovalVisual;
type AggregatePollingVisual = { kind: "aggregate-polling" };
type ActiveProjectsVisual = { kind: "active-projects"; active: ScenarioProject[]; inactive: ScenarioProject[] };
type ServiceRecoveryVisual = { kind: "service-recovery"; phase: import("../test/harness/CoupledServiceRecoveryScenario.ts").ServiceRecoveryPhase };
type ScenarioProject = { id: string; name: string; blobs: Array<{ id: string; title: string; status: string; stepId: string; completedStepIds: string[] }> };

const port = workbenchPort(process.argv);
const databasePath = resolve(argument("--db") ?? "pipelines/axi-factorio.db");
const mockLab = new MockHarnessLab();
const liveExecutionScenario = new LiveExecutionScenario();
const cursorActionScenario = new CursorActionScenario();
const localEndpointScenario = new LocalEndpointScenario();
const projectRemovalScenario = new ProjectRemovalScenario();
const axiValidationScenario = new AxiValidationScenario();
const coupledServiceRecoveryScenario = new CoupledServiceRecoveryScenario();
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/api/scenarios") return json(response, scenarioIndex());
    if (url.pathname === "/api/database") return json(response, databaseSnapshot());
    if (url.pathname === "/api/tests") return json(response, listVisualTests());
    if (url.pathname === "/api/mock-lab" && request.method === "GET") {
      return json(response, mockLab.snapshot());
    }
    if (url.pathname.startsWith("/api/mock-lab/scenario/") && request.method === "POST") {
      return json(response, await mockLab.selectScenario(url.pathname.split("/").at(-1) ?? ""));
    }
    if (url.pathname === "/api/mock-lab/blob/preview" && request.method === "POST") {
      const body = await readJsonBody(request);
      return json(response, mockLab.previewBlobEdit(String(body.body ?? "")));
    }
    if (url.pathname === "/api/mock-lab/blob/save" && request.method === "POST") {
      return json(response, mockLab.saveBlobEdit());
    }
    if (url.pathname === "/api/mock-lab/prompt/preview" && request.method === "POST") {
      const body = await readJsonBody(request);
      const kind = body.kind === "exit" ? "exit" : "entry";
      return json(response, mockLab.previewPromptEdit(kind, String(body.content ?? "")));
    }
    if (url.pathname === "/api/mock-lab/prompt/save" && request.method === "POST") {
      return json(response, mockLab.savePromptEdit());
    }
    if (url.pathname === "/api/mock-lab/edit/cancel" && request.method === "POST") {
      return json(response, mockLab.cancelEdit());
    }
    if (url.pathname.startsWith("/api/mock-lab/") && request.method === "POST") {
      const action = url.pathname.split("/").at(-1) as LabAction;
      return json(response, await mockLab.action(action));
    }
    if (url.pathname.startsWith("/api/tests/") && request.method === "POST") {
      return json(response, await runVisualTest(getVisualTest(url.pathname.split("/").at(-2) ?? "")));
    }
    if (url.pathname === "/api/live-execution/play" && request.method === "POST") {
      return json(response, await liveExecutionScenario.play());
    }
    if (url.pathname === "/api/live-execution/reset" && request.method === "POST") {
      return json(response, await liveExecutionScenario.reset());
    }
    if (url.pathname === "/api/cursor-action/play" && request.method === "POST") {
      return json(response, await cursorActionScenario.play());
    }
    if (url.pathname === "/api/cursor-action/reset" && request.method === "POST") {
      return json(response, cursorActionScenario.reset());
    }
    if (url.pathname.startsWith("/api/cursor-action/open/") && request.method === "POST") {
      return json(response, await cursorActionScenario.open(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")));
    }
    if (url.pathname === "/api/local-endpoint/play" && request.method === "POST") {
      return json(response, await localEndpointScenario.play());
    }
    if (url.pathname.startsWith("/api/local-endpoint/") && request.method === "POST") {
      const action = url.pathname.split("/").at(-1) as "approve" | "reject" | "restart" | "recover" | "poll" | "reset";
      return json(response, await (action === "recover"
        ? localEndpointScenario.recoverLostChild()
        : action === "poll" ? localEndpointScenario.pollStable() : localEndpointScenario[action]()));
    }
    if (url.pathname === "/api/project-removal/remove" && request.method === "POST") {
      return json(response, projectRemovalScenario.remove());
    }
    if (url.pathname === "/api/project-removal/reset" && request.method === "POST") {
      return json(response, projectRemovalScenario.reset());
    }
    if (url.pathname === "/api/axi-validation/play" && request.method === "POST") {
      return json(response, axiValidationScenario.play());
    }
    if (url.pathname === "/api/axi-validation/reset" && request.method === "POST") {
      return json(response, axiValidationScenario.reset());
    }
    if (url.pathname === "/api/coupled-service-recovery/play" && request.method === "POST") {
      return json(response, await coupledServiceRecoveryScenario.play());
    }
    if (url.pathname === "/api/coupled-service-recovery/reset" && request.method === "POST") {
      return json(response, coupledServiceRecoveryScenario.reset());
    }
    if (url.pathname.startsWith("/api/scenarios/")) return json(response, await scenario(url));
    if (url.pathname === "/") return html(response, workbenchHtml);
    response.writeHead(404).end("Not found");
  } catch (error) {
    json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  log("workbench.ready", { url: `http://127.0.0.1:${port}`, databasePath });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    mockLab.dispose();
    cursorActionScenario.dispose();
    projectRemovalScenario.dispose();
    void Promise.all([localEndpointScenario.dispose(), liveExecutionScenario.dispose()])
      .finally(() => server.close(() => process.exit(0)));
  });
}

function scenarioIndex(): object[] {
  return [
    {
      id: "happy", category: "Conveyor", name: "Default happy path",
      description: "Real runner · fresh SQLite · test/harness/default",
    },
    {
      id: "codex-active-turn", category: "Harness", name: "Active Codex reconciliation",
      description: "notLoaded container · fresh active turn · production receipt path",
    },
    {
      id: "interrupted-continuation-boundary", category: "Harness", name: "Fresh task after interruption",
      description: "same blob + same step · immutable failed receipt · new external task",
    },
    {
      id: "empty-launch-recovery", category: "Harness", name: "Empty provider launch recovery",
      description: "one receipt · cancelled empty task · fresh provider subattempt",
    },
    {
      id: "codex-mcp-isolation", category: "Harness", name: "Pinned Codex MCP isolation",
      description: "0.144.6 argv contract · unrelated MCP failure · production receipt path",
    },
    {
      id: "codex-writable-continuation", category: "Harness", name: "Writable Codex continuation",
      description: "entry retry · same-task continuation · exit advance · durable artifact",
    },
    {
      id: "blob-workspace-relocation", category: "Workspace", name: "Blob workspace relocation",
      description: "root A → deliberate rebind → next receipt only in root B",
    },
    {
      id: "codex-execution-workspace", category: "Workspace", name: "Codex execution workspace",
      description: "app project root + assigned workspace sandbox + sibling fixture",
    },
    {
      id: "live-execution-visibility", category: "Execution", name: "Execution sessions: task movement",
      description: "Play · watch one task stay or advance on its real pipeline · Reset",
    },
    {
      id: "viewer-overview-boundary", category: "Viewer", name: "Viewer Overview boundary",
      description: "Before: internal diagnostics displace projects · After: pipeline is primary",
    },
    {
      id: "viewer-resilience", category: "Viewer", name: "Viewer resilience",
      description: "Healthy project + missing disposable pipeline + isolated diagnosis",
    },
    {
      id: "cursor-action", category: "Viewer", name: "Configured task opener",
      description: "Title menu · default Cursor · assigned root + unavailable path · real action component",
    },
    {
      id: "local-endpoint-supervisor", category: "Service", name: "Durable declared local endpoint",
      description: "Receipt ends → endpoint lease stays live → restart recovery → owned cleanup",
    },
    {
      id: "coupled-service-recovery", category: "Service", name: "Coupled listener recovery",
      description: "Play · listener closes · dispatcher exits · same receipt reconciles · Reset",
    },
    {
      id: "project-removal", category: "Store", name: "Safe project removal",
      description: "Preview exact graph · confirm with evidence · remove · Reset",
    },
    {
      id: "aggregate-polling", category: "Viewer", name: "Stable aggregate pipeline",
      description: "Pinned project · continuous 12 o'clock progress arcs · unchanged nodes across polling",
    },
    {
      id: "active-projects-fold", category: "Viewer", name: "Active projects fold",
      description: "Active by default · reveal completed and empty · one vertical page scroller",
    },
    {
      id: "axi-validation", category: "AXI validation", name: "Ten AXI principles",
      description: "Play · actual CLI checks · watch each published principle pass · Reset",
    },
  ];
}

async function scenario(url: URL): Promise<Scenario> {
  const id = url.pathname.split("/").at(-1);
  if (id === "happy") return runHappyPath();
  if (id === "codex-active-turn") {
    const { runCodexActiveTurnScenario } = await import("../test/harness/CodexActiveTurnScenario.ts");
    return runCodexActiveTurnScenario();
  }
  if (id === "interrupted-continuation-boundary") {
    const { runInterruptedContinuationScenario } =
      await import("../test/harness/InterruptedContinuationScenario.ts");
    return runInterruptedContinuationScenario();
  }
  if (id === "empty-launch-recovery") {
    const { runEmptyLaunchRecoveryScenario } =
      await import("../test/harness/EmptyLaunchRecoveryScenario.ts");
    return runEmptyLaunchRecoveryScenario();
  }
  if (id === "codex-mcp-isolation") {
    const { runCodexMcpIsolationScenario } = await import("../test/harness/CodexMcpIsolationScenario.ts");
    return runCodexMcpIsolationScenario();
  }
  if (id === "codex-writable-continuation") {
    const { runCodexWritableContinuationScenario } =
      await import("../test/harness/CodexWritableContinuationScenario.ts");
    return runCodexWritableContinuationScenario();
  }
  if (id === "blob-workspace-relocation") {
    const { runBlobWorkspaceRelocationScenario } =
      await import("../test/harness/BlobWorkspaceRelocationScenario.ts");
    return runBlobWorkspaceRelocationScenario();
  }
  if (id === "codex-execution-workspace") {
    const { runCodexExecutionWorkspaceScenario } =
      await import("../test/harness/CodexExecutionWorkspaceScenario.ts");
    return runCodexExecutionWorkspaceScenario();
  }
  if (id === "live-execution-visibility") return liveExecutionScenario.snapshot();
  if (id === "viewer-overview-boundary") return overviewBoundaryScenario();
  if (id === "viewer-resilience") {
    const { runViewerResilienceScenario } =
      await import("../test/harness/ViewerResilienceScenario.ts");
    return runViewerResilienceScenario();
  }
  if (id === "cursor-action") return cursorActionScenario.snapshot();
  if (id === "local-endpoint-supervisor") return localEndpointScenario.snapshot() as unknown as Scenario;
  if (id === "coupled-service-recovery") return coupledServiceRecoveryScenario.snapshot() as unknown as Scenario;
  if (id === "project-removal") return projectRemovalScenario.snapshot() as unknown as Scenario;
  if (id === "aggregate-polling") return aggregatePollingScenario();
  if (id === "active-projects-fold") {
    const { runActiveProjectsScenario } = await import("../test/harness/ActiveProjectsScenario.ts");
    return runActiveProjectsScenario() as unknown as Scenario;
  }
  if (id === "axi-validation") return axiValidationScenario.snapshot() as unknown as Scenario;
  throw new Error(`Unknown scenario: ${id}`);
}

function aggregatePollingScenario(): Scenario {
  return {
    id: "aggregate-polling",
    frames: [{
      name: "Stable aggregate pipeline",
      description: "Play several refreshes. The project and disclosure stay pinned while the same ring nodes update.",
      source: "scenario", steps: [], blobs: [], receipts: [], assertions: [],
      visual: { kind: "aggregate-polling" },
    }],
  };
}

function databaseSnapshot(): ViewSnapshot {
  const database = new FactorioDatabase(databasePath);
  try {
    const store = new ConveyorStore(database);
    const blobs = store.listBlobs();
    const receipts = store.listReceipts();
    const stepIds = [...new Set(blobs.flatMap((blob) => discoverPipeline(blob.pipelinePath).map((step) => step.id)))];
    return {
      name: basename(databasePath), description: databasePath, source: "database",
      steps: stepIds.map(viewStep), blobs: blobs.map((blob) => viewBlob(blob, receipts)),
      receipts: receipts.map(viewReceipt), assertions: [],
    };
  } finally {
    database.close();
  }
}

function overviewBoundaryScenario(): Scenario {
  const base = {
    name: "Viewer Overview boundary",
    source: "scenario" as const,
    steps: ["plan", "build", "qa", "review"].map(viewStep),
    blobs: [{ id: "feature-one", title: "Compact header", state: "running", stepId: "qa" }],
    receipts: [], evidenceCards: [],
  };
  const diagnosticHtml = executionOverviewMarkup([overviewBoundarySession], []);
  return {
    id: "viewer-overview-boundary",
    frames: [
      {
        ...base,
        description: "Before · a development execution specimen occupies the first viewport.",
        assertions: [{ label: "Diagnostics displace the project pipeline", passed: false }],
        visual: { kind: "overview-boundary", phase: "leaked", diagnosticHtml } as OverviewBoundaryVisual,
      },
      {
        ...base,
        description: "After · Overview begins with projects and task beads; diagnostics are absent.",
        assertions: [{ label: "Project pipeline is the first and primary surface", passed: true }],
        visual: { kind: "overview-boundary", phase: "clean", diagnosticHtml: "" } as OverviewBoundaryVisual,
      },
    ],
  };
}

const overviewBoundarySession = {
  projectId: "example", projectName: "Example app", blobId: "feature-one", blobTitle: "Compact header",
  stepId: "qa", attempt: 2, receiptId: "receipt-debug-specimen", harness: "fixture-agent",
  model: null, reasoningEffort: null, sessionId: "session-debug-specimen", status: "running" as const,
  queuedAt: "2026-07-21T07:00:00.000Z", startedAt: "2026-07-21T07:00:01.000Z", finishedAt: null,
  elapsedMs: 12_000, lastProgressAt: "2026-07-21T07:00:12.000Z", currentOperation: "Evaluating output",
  inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
  terminalReason: null, executionWorkspace: "/private/tmp/internal-debug-fixture", stale: false,
};

async function runHappyPath(): Promise<Scenario> {
  const { createTestHarness } = await import("../test/harness/CreateTestHarness.ts");
  const harness = createTestHarness();
  const frames: ViewSnapshot[] = [];
  try {
    harness.store.createBlob("blob-happy", {
      title: "Default harness blob", body: "", cwd: process.cwd(),
      pipelinePath: harness.pipelinePath, inputArtifacts: [],
    });
    harness.store.requestContinuous("blob-happy");
    const capture = () => frames.push(harnessSnapshot(harness));
    harness.adapter.onExecute = capture;
    capture();
    while (harness.store.getBlob("blob-happy")?.state !== "complete") {
      await harness.runner.runOnce();
      capture();
    }
    return { id: "happy", frames };
  } finally {
    harness.dispose();
  }
}

function harnessSnapshot(harness: TestHarness): ViewSnapshot {
  const blobs = harness.store.listBlobs();
  const receipts = harness.store.listReceipts();
  const final = blobs[0]?.state === "complete";
  return {
    name: "Default happy path",
    description: "Executed by ConveyorRunner against test/harness/default and a fresh SQLite database.",
    source: "scenario", steps: harness.steps.map((step) => viewStep(step.id)),
    blobs: blobs.map((blob) => viewBlob(blob, receipts)),
    receipts: receipts.map(viewReceipt),
    assertions: [
      { label: "Loaded 3 paired Markdown stages", passed: harness.steps.length === 3 },
      { label: "Actual runner wrote one receipt per completed stage", passed: receipts.length <= 3 },
      { label: "Blob completed through g3.third", passed: !final || blobs[0]?.lastCompletedStepId === "g3.third" },
    ],
  };
}

function viewStep(id: string): ViewStep {
  return { id, label: titleCase(id.split(".").at(-1) ?? id) };
}

function viewBlob(blob: Blob, receipts: Receipt[]): ViewBlob {
  return { id: blob.id, title: blob.title, state: displayStatus(blob, receipts), stepId: blob.state };
}

function viewReceipt(receipt: Receipt): ViewReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId,
    status: receipt.invalidatedAt ? "invalidated" : receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.reason ?? receipt.error ?? `attempt ${receipt.attempt}`,
  };
}

function displayStatus(blob: Blob, receipts: Receipt[]): string {
  if (blob.state === "complete") return "complete";
  const latest = receipts.filter((receipt) => receipt.blobId === blob.id && !receipt.invalidatedAt).at(-1);
  if (latest?.status === "running") return "running";
  if (latest?.status === "failed") return "failed";
  if (latest?.status === "blocked") return "blocked";
  if (blob.paused && !latest) return "held";
  if (blob.paused) return "waiting";
  return "ready";
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object request body.");
  }
  return parsed as Record<string, unknown>;
}

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(value);
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

const workbenchHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Factorio Workbench</title><style>
:root{color-scheme:light;--canvas:#fff;--rail:#fbfcfb;--line:#e7ebe8;--line-strong:#dce2de;--muted:#737d77;--quiet:#bfc6c2;--ink:#18201b;--green:#0caf69;--neutral-soft:#eef1ef;--attention:#c87918;--attention-soft:#faecd9;--danger:#ce5353;--danger-soft:#f8e7e7}
*{box-sizing:border-box}html,body{min-height:100%}body{margin:0;background:var(--canvas);color:var(--ink);font:12px/1.4 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}button,input,select{font:inherit;color:inherit}.app{min-height:100vh}.topbar{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 22px;gap:8px}.identity{display:flex;align-items:center;gap:8px;min-width:220px}.identity strong{font-size:13px;letter-spacing:-.02em}.online{font-size:9px;color:var(--muted)}.online:before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--green);margin-right:5px;vertical-align:1px}.modes{display:flex;gap:3px;margin-left:16px;padding:3px;background:#f5f7f5;border-radius:6px}.mode{height:25px;border:0;border-radius:4px;background:transparent;padding:0 10px;color:var(--muted);cursor:pointer;font-size:9px}.mode.active{background:#fff;color:var(--ink);box-shadow:0 0 0 1px var(--line)}.actions{margin-left:auto;display:flex;align-items:center;gap:6px}.control{height:30px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:0 10px;cursor:pointer;color:var(--muted)}.control:hover{background:#f7f9f8;color:var(--ink)}.control.primary{background:var(--ink);border-color:var(--ink);color:#fff}.control:disabled{opacity:.42;cursor:default}
.content{padding:14px 20px 26px;min-width:0}.toolbar{min-height:48px;display:flex;align-items:center;gap:10px}.scenario-copy{min-width:0}.scenario-copy strong{display:block;font-size:11px}.scenario-copy span{display:block;color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:680px}.picker{margin-left:auto;height:28px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:0 26px 0 9px;font-size:9px;max-width:270px}.frame{color:var(--muted);font-size:9px;min-width:66px;text-align:right}.workspace{border:1px solid var(--line);background:#fff;overflow:auto;max-width:100%;min-height:210px}.matrix{width:100%}.matrix-head{display:grid;grid-template-columns:170px repeat(var(--steps),minmax(72px,1fr));background:#fff}.corner{grid-row:span 2;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.band{height:30px;display:flex;align-items:center;justify-content:center;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:#f7f8f7;color:#5f6963}.step{height:56px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:center;padding:7px;text-align:center;color:#505b55;font-size:9px;line-height:1.25}.project-head{width:100%;height:37px;display:flex;align-items:center;border:0;background:#fff;padding:0 10px;text-align:left;font-weight:700;font-size:10px}.project-head .count{margin-left:6px;color:var(--muted);font-weight:400}.project-head .source-tag{margin-left:auto;color:var(--muted);font-size:9px;font-weight:400}.taskrow{display:grid;grid-template-columns:170px repeat(var(--steps),minmax(72px,1fr));height:40px;align-items:center}.task-title{height:40px;display:flex;align-items:center;gap:6px;padding:0 10px 0 24px;color:#3f4944;font-size:10px}.task-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-status{margin-left:auto;flex:none;color:var(--muted);font-size:8px}.task-status.waiting,.task-status.blocked{color:var(--attention);font-weight:700}.task-status.failed{color:var(--danger);font-weight:700}.track-cell{height:40px;position:relative}.track-cell:before{content:"";position:absolute;left:0;right:0;top:20px;height:1px;background:var(--line-strong)}.track-cell.first:before{left:50%}.track-cell.last:before{right:50%}.bead{position:absolute;z-index:1;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%;background:var(--quiet)}.bead.done{width:12px;height:12px;margin:-6px;background:var(--ink)}.bead.done:after{content:"✓";position:absolute;inset:-1px 0 0;color:#fff;text-align:center;font-size:8px;font-style:normal;font-weight:800}.bead.current{width:12px;height:12px;margin:-6px;background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.bead.current.running{background:var(--ink)}.bead.current.waiting,.bead.current.blocked{border-style:double;border-color:var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}.bead.current.failed{border-color:var(--danger);box-shadow:0 0 0 2px var(--danger-soft)}.bead.current.failed:after{content:"×";position:absolute;inset:-4px 0 0;color:var(--danger);text-align:center;font-size:11px;font-style:normal;font-weight:800}.empty{padding:54px 24px;text-align:center;color:var(--muted)}
.footer{display:flex;align-items:center;gap:18px;padding:12px 4px 0;color:var(--muted);font-size:9px}.legend{display:flex;align-items:center;gap:15px;flex-wrap:wrap}.legend span{display:flex;align-items:center;gap:6px}.key{position:relative;width:8px;height:8px;border-radius:50%;background:var(--quiet)}.key.complete{width:11px;height:11px;background:var(--ink)}.key.complete:after{content:"✓";position:absolute;inset:-2px 0 0;color:#fff;text-align:center;font-size:8px}.key.imported{width:10px;height:10px;border-radius:2px;background:#fff;border:1px dashed #69736d;transform:rotate(45deg)}.key.inventory{width:10px;height:10px;border-radius:2px;background:#fff;border:1px solid var(--quiet)}.key.current{width:11px;height:11px;background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.key.waiting{width:11px;height:11px;background:#fff;border:3px double var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}.key.failed{width:11px;height:11px;background:#fff;border:1px solid var(--danger)}.total{margin-left:auto}.lab-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:9px 0}.lab-actions button{height:27px;border:1px solid var(--line);background:#fff;border-radius:5px;padding:0 9px;cursor:pointer}.lab-actions button:hover{background:#f5f7f5}.lab-actions .run-control{width:27px;padding:0;display:grid;place-items:center;border-color:var(--line-strong);color:#46504a}.run-control svg{width:11px;height:11px;fill:currentColor}.lab-facts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);border-top:0}.lab-fact{padding:8px 10px;border-right:1px solid var(--line)}.lab-fact:last-child{border-right:0}.lab-fact small{display:block;color:var(--muted);font-size:8px}.lab-fact b{font-size:9px;word-break:break-all}.inspector{margin-top:18px;border-top:1px solid var(--line);color:var(--muted)}.inspector summary{height:38px;display:flex;align-items:center;gap:7px;cursor:pointer;font-size:9px;text-transform:uppercase;letter-spacing:.04em}.inspector summary span{font-weight:700;color:var(--ink)}.evidence{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);border:1px solid var(--line)}.panel+.panel{border-left:1px solid var(--line)}.panel-head{height:32px;padding:0 10px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;font-size:9px;text-transform:uppercase;letter-spacing:.04em}.event{display:grid;grid-template-columns:58px 110px 90px minmax(0,1fr);gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);font-size:9px}.event span{color:var(--muted)}.check{padding:9px 10px;border-bottom:1px solid var(--line);font-size:9px}.pass{color:var(--green)}.fail{color:var(--danger)}.visual-proof{padding:24px;text-align:center;color:var(--muted)}.proof-map{display:grid;grid-template-columns:repeat(3,1fr);max-width:650px;margin:20px auto}.proof-node{position:relative;padding-top:24px;font-size:9px}.proof-node:before{content:"";position:absolute;left:0;right:0;top:8px;height:1px;background:var(--line-strong)}.proof-node:first-child:before{left:50%}.proof-node:last-child:before{right:50%}.proof-node i{position:absolute;left:50%;top:4px;transform:translateX(-50%);width:8px;height:8px;border-radius:50%;background:var(--quiet)}.proof-node.done i{width:12px;height:12px;top:2px;background:var(--ink)}.proof-node.current i{width:12px;height:12px;top:2px;background:#fff;border:2px solid var(--ink)}.pulse{animation:pulse .55s ease}@keyframes pulse{50%{background:#f7f9f8}}@media(max-width:760px){.topbar{height:auto;min-height:92px;flex-wrap:wrap;padding-block:12px}.identity{min-width:auto}.modes{order:3;margin:0;width:100%}.mode{flex:1}.content{padding-inline:12px}.matrix-head,.taskrow{grid-template-columns:145px repeat(var(--steps),minmax(66px,1fr))}.evidence{grid-template-columns:1fr}.panel+.panel{border-left:0;border-top:1px solid var(--line)}.lab-facts{grid-template-columns:1fr 1fr}.lab-fact{border-bottom:1px solid var(--line)}}
.learning-toolbar{display:flex;gap:7px;align-items:center;padding:10px 0}.learning-toolbar select{margin-left:auto;max-width:330px;height:30px;border:1px solid var(--line);background:#fff;border-radius:5px;padding:0 8px}.step-primary{height:30px;border:1px solid var(--ink);border-radius:5px;background:var(--ink);color:#fff;padding:0 14px;font-weight:700;cursor:pointer}.play-secondary,.quiet-action{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 10px;cursor:pointer;color:#59635d}.step-primary:disabled,.quiet-action:disabled,.play-secondary:disabled{opacity:.38;cursor:default}.learning-layout{display:grid;grid-template-columns:minmax(290px,.72fr) minmax(0,1.28fr);gap:12px;margin-top:12px}.learning-panel{border:1px solid var(--line);background:#fff}.learning-panel h3{height:34px;margin:0;padding:0 11px;border-bottom:1px solid var(--line);display:flex;align-items:center;font-size:10px}.learning-panel h3 small{margin-left:auto;color:var(--muted);font-weight:400}.attempt-list{padding:6px}.attempt-card{width:100%;text-align:left;border:1px solid var(--line);background:#fff;border-radius:5px;padding:8px;margin-bottom:5px;cursor:pointer}.attempt-card.current{border-color:var(--ink)}.attempt-card.invalidated{border-style:dashed;color:#6e7772}.attempt-card b{display:block;font-size:9px}.attempt-card span{font-size:8px;color:var(--muted)}.attempt-detail{padding:10px}.evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.evidence-card{border:1px solid var(--line);padding:8px;min-width:0}.evidence-card.wide{grid-column:1/-1}.evidence-card small{display:block;color:var(--muted);font-size:8px}.evidence-card b,.evidence-card pre{display:block;margin:3px 0 0;font-size:9px;white-space:pre-wrap;word-break:break-word}.editors{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.editor{border:1px solid var(--line);padding:10px}.editor h3{font-size:10px;margin:0 0 7px}.editor textarea{width:100%;min-height:92px;resize:vertical;border:1px solid var(--line-strong);border-radius:4px;padding:8px;font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.editor select{height:27px;border:1px solid var(--line-strong);background:#fff;border-radius:4px;margin-bottom:6px}.editor-actions{display:flex;gap:5px;margin-top:6px}.diff-view{margin-top:8px;border:1px solid var(--line);background:#fafbfa;font:9px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:150px;overflow:auto}.diff-line{padding:1px 6px;white-space:pre-wrap}.diff-line.add{color:#26754e;background:#f0f8f3}.diff-line.remove{color:#a44747;background:#fff3f3}.validation-error{margin-top:7px;padding:7px;border:1px solid #e6c8c8;background:#fff7f7;color:#9e4444;font-size:9px}.comparison{grid-column:1/-1;border:1px solid var(--line);background:#fff}.comparison-grid{display:grid;grid-template-columns:1fr 1fr}.comparison-attempt{padding:9px;border-right:1px solid var(--line);font-size:9px}.comparison-attempt:last-child{border-right:0}.comparison-attempt b{display:block}.hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.scenario-note{padding:8px 10px;border-top:1px solid var(--line);color:var(--muted);font-size:9px}@media(max-width:900px){.learning-layout,.editors{grid-template-columns:1fr}.comparison{grid-column:auto}}
.scenario-debug{border-top:1px solid var(--line);padding:10px;background:#fff}.scenario-debug summary{cursor:pointer;font-size:9px;font-weight:700;color:var(--muted)}.scenario-debug .evidence-grid{padding-top:9px}
${liveExecutionStyles}
.endpoint-flow{grid-template-columns:repeat(8,1fr)}
.workspace:has(.active-projects-demo){overflow-x:auto;overflow-y:visible}.active-projects-demo{min-width:720px;background:#fff}.active-projects-controls{position:sticky;left:0;display:flex;align-items:center;gap:6px;width:min(100vw - 40px,100%);padding:10px 12px;border-bottom:1px solid var(--line);background:#fff}.active-projects-controls button{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 12px;cursor:pointer}.active-projects-controls .play{background:var(--ink);color:#fff}.active-projects-controls span{margin-left:auto;color:var(--muted);font-size:9px}.active-project-card+.active-project-card{border-top:1px solid var(--line)}.active-project-head{display:grid;grid-template-columns:180px 60px minmax(360px,1fr) 36px;height:38px;align-items:center}.active-project-head>b{position:sticky;left:0;height:38px;display:flex;align-items:center;padding:0 12px;background:#fff;z-index:2}.active-project-head>span{color:var(--muted);font-size:9px}.active-project-track,.active-task-track{display:grid;grid-template-columns:repeat(4,minmax(72px,1fr));align-items:center;height:100%}.active-project-track i,.active-task-track i{position:relative;width:9px;height:9px;margin:auto;border-radius:50%;background:var(--quiet)}.active-project-track i:before,.active-task-track i:before{content:"";position:absolute;left:-38px;right:8px;top:4px;height:1px;background:var(--line-strong);z-index:-1}.active-project-track i:first-child:before,.active-task-track i:first-child:before{display:none}.active-project-track i.done,.active-task-track i.done{background:var(--ink)}.active-project-track i.current,.active-task-track i.current{width:12px;height:12px;background:#fff;border:2px solid var(--ink)}.active-task-track i.attention{border-color:var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}.active-project-chevron{position:sticky;right:0;height:38px;display:grid;place-items:center;background:#fff}.active-project-task{display:grid;grid-template-columns:240px minmax(360px,1fr) 72px;height:34px;align-items:center}.active-project-task>span{position:sticky;left:0;height:34px;display:flex;align-items:center;padding-left:24px;background:#fff;font-size:9px;z-index:2}.active-project-task>small{position:sticky;right:0;height:34px;display:flex;align-items:center;background:#fff;color:var(--muted)}.active-project-empty{padding:9px 24px;color:var(--muted);font-size:9px}.active-projects-fold{height:42px;border-block:1px solid var(--line);background:#fafbfa}.active-projects-fold button{position:sticky;left:0;height:42px;border:0;background:transparent;padding:0 14px;font-weight:700;cursor:pointer}.active-projects-fold span{display:inline-block;width:18px;color:var(--muted)}.active-projects-fold small{margin-left:7px;color:var(--muted)}
.live-scenario{padding:12px;background:#fafbfa}.live-scenario-controls{display:flex;align-items:center;gap:6px;margin-bottom:10px}.live-scenario-controls button{height:32px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 12px;cursor:pointer}.live-scenario-controls .play{background:var(--ink);border-color:var(--ink);color:#fff}.live-scenario-controls button:disabled{opacity:.4;cursor:not-allowed}.live-scenario-controls span{margin-left:auto;color:var(--muted);font-size:10px;text-transform:uppercase}.activity-track{display:flex;align-items:center;gap:0;margin-top:12px;border:1px solid var(--line);background:#fff;padding:12px}.activity-node{display:flex;align-items:center;min-width:0;flex:1;color:var(--muted);font-size:10px}.activity-node:before{content:"";width:9px;height:9px;border-radius:50%;background:var(--quiet);margin-right:7px;flex:none}.activity-node.done{color:var(--ink)}.activity-node.done:before{background:var(--ink)}.activity-node.current{color:var(--ink);font-weight:750}.activity-node.current:before{background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 3px var(--neutral-soft)}.activity-node+.activity-node:after{content:"";height:1px;background:var(--line-strong);width:24px;order:-1;margin-right:8px}.activity-log{margin-top:8px;display:flex;gap:5px;flex-wrap:wrap}.activity-log span{border:1px solid var(--line);border-radius:999px;background:#fff;padding:5px 8px;color:var(--muted);font-size:9px}
.bead.current.retry{border-style:double;border-color:var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}
.resilience-projects{display:grid;gap:0;border-bottom:1px solid var(--line)}.resilience-project{min-height:44px;display:grid;grid-template-columns:minmax(180px,1fr) 150px minmax(220px,1.4fr);align-items:center;padding:7px 12px;border-bottom:1px solid var(--line);font-size:9px}.resilience-project:last-child{border-bottom:0}.resilience-project>div b{display:block;font-size:10px}.resilience-project>div span,.resilience-project small{color:var(--muted)}.resilience-project strong{justify-self:start;border:1px solid var(--line);border-radius:999px;padding:3px 8px;font-size:8px}.resilience-project.unavailable{background:#fffaf3}.resilience-project.unavailable strong{border-color:#e5c89f;background:#fff8ed;color:#986016}
.cursor-action-visual{background:#fff}.cursor-action-controls{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line)}.cursor-action-controls button{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 11px;cursor:pointer}.cursor-action-controls .play{background:var(--ink);border-color:var(--ink);color:#fff}.cursor-action-controls span{margin-left:auto;color:var(--muted);font-size:9px}.cursor-action-row{min-height:54px;display:grid;grid-template-columns:minmax(180px,.8fr) minmax(240px,1.4fr) auto;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid var(--line)}.cursor-action-row b{font-size:10px}.cursor-action-row small{display:block;color:var(--muted);font-size:8px}.cursor-action-row code{color:var(--muted);font:9px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.cursor-action-row .run-control.cursor{width:auto;min-width:106px;padding:0 9px;display:flex;gap:6px}.cursor-action-row .run-control.cursor svg{fill:none;stroke:currentColor;stroke-width:1.6}.cursor-action-result{padding:9px 12px;background:#f7f9f8;color:#52605a;font-size:9px}.cursor-action-result.failure{background:var(--danger-soft);color:var(--danger)}
.endpoint-visual{background:#fff}.endpoint-controls{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}.endpoint-controls button{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 12px;cursor:pointer}.endpoint-controls .play{background:var(--ink);color:#fff}.endpoint-controls span{margin-left:auto;color:var(--muted);font-size:9px}.endpoint-flow{display:grid;grid-template-columns:repeat(6,1fr);padding:16px 24px;border-bottom:1px solid var(--line)}.endpoint-phase{position:relative;text-align:center;padding-top:22px;color:var(--muted);font-size:9px}.endpoint-phase:before{content:"";position:absolute;left:0;right:0;top:8px;height:1px;background:var(--line-strong)}.endpoint-phase:first-child:before{left:50%}.endpoint-phase:last-child:before{right:50%}.endpoint-phase i{position:absolute;left:50%;top:3px;width:11px;height:11px;margin-left:-5px;border:2px solid var(--quiet);border-radius:50%;background:#fff}.endpoint-phase.done{color:var(--ink);font-weight:700}.endpoint-phase.done i{border-color:var(--ink);background:var(--ink);box-shadow:inset 0 0 0 3px #fff}.endpoint-phase.current i{border-color:var(--attention);box-shadow:0 0 0 3px var(--attention-soft)}.endpoint-facts{display:grid;grid-template-columns:1.2fr 1fr .8fr .8fr;border-bottom:1px solid var(--line)}.endpoint-fact{padding:10px 12px;border-right:1px solid var(--line);min-width:0}.endpoint-fact:last-child{border-right:0}.endpoint-fact small{display:block;color:var(--muted);font-size:8px}.endpoint-fact b,.endpoint-fact code{display:block;overflow-wrap:anywhere;font-size:9px;line-height:1.35}.endpoint-fact code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.endpoint-visual .matrix{border-top:0}
.live-scenario{padding:0}.live-scenario-controls{margin:0;padding:12px}.live-conveyor{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff}.live-details{padding:12px}.live-details .live-panel{margin-bottom:8px}
.overview-boundary{background:#fff}.boundary-state{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line)}.boundary-state b{font-size:10px}.boundary-state span{color:var(--muted);font-size:9px}.boundary-state.leaked{background:var(--danger-soft);color:var(--danger)}.boundary-state.clean{background:var(--neutral-soft)}.overview-boundary>.live-panel{margin:12px}.boundary-pipeline{border-top:1px solid var(--line)}
.removal-visual{padding:18px;background:#fff}.removal-controls{display:flex;gap:7px;align-items:center;margin-bottom:16px}.removal-controls button{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 12px;cursor:pointer}.removal-controls .remove{background:var(--ink);color:#fff}.removal-controls button:disabled{opacity:.4;cursor:default}.removal-controls span{margin-left:auto;color:var(--muted);font-size:9px}.removal-scope{display:grid;grid-template-columns:1.6fr repeat(2,.7fr) 1fr;border:1px solid var(--line)}.removal-fact{padding:12px;border-right:1px solid var(--line)}.removal-fact:last-child{border-right:0}.removal-fact small{display:block;color:var(--muted);font-size:8px}.removal-fact b{display:block;margin-top:3px;font-size:11px}.removal-result{margin-top:10px;padding:10px;border:1px solid var(--line);background:#f7f9f8;font-size:9px}@media(max-width:700px){.removal-scope{grid-template-columns:1fr 1fr}.removal-fact{border-bottom:1px solid var(--line)}}
.cursor-action-row{grid-template-columns:minmax(180px,.8fr) minmax(240px,1.4fr)}.cursor-action-row .task-name-button{border:0;background:transparent;padding:0;text-align:left;cursor:pointer;font-weight:700;font-size:10px}.cursor-action-row .task-name-button:hover{text-decoration:underline}.blob-menu{position:fixed;z-index:1000;min-width:148px;padding:4px;border:1px solid var(--line-strong);border-radius:7px;background:#fff;box-shadow:0 10px 28px #18201b24}.blob-menu[hidden]{display:none}.blob-menu button{width:100%;height:31px;border:0;border-radius:4px;background:transparent;padding:0 10px;text-align:left;cursor:pointer;font-size:10px}.blob-menu button:hover,.blob-menu button:focus-visible{background:var(--neutral-soft);outline:0}.blob-menu button:disabled{color:#a9b0ac;cursor:not-allowed}.blob-menu small{display:block;padding:5px 10px;color:var(--muted);font-size:8px;max-width:220px}
.aggregate-demo{background:#fff}.aggregate-demo-controls{display:flex;align-items:center;gap:7px;padding:12px;border-bottom:1px solid var(--line)}.aggregate-demo-controls button{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 12px;cursor:pointer}.aggregate-demo-controls .play{background:var(--ink);border-color:var(--ink);color:#fff}.aggregate-demo-health{margin-left:auto;display:flex;align-items:center;gap:7px;color:var(--muted);font-size:9px}.aggregate-demo-health i{width:8px;height:8px;border-radius:50%;background:var(--quiet)}.aggregate-demo-health.stable{color:#387359}.aggregate-demo-health.stable i{background:var(--green)}.aggregate-demo-frame{overflow-x:auto;max-width:100%;border-bottom:1px solid var(--line)}.aggregate-demo-row{min-width:820px;height:54px;display:grid;grid-template-columns:190px repeat(8,minmax(72px,1fr)) 38px;align-items:center}.aggregate-demo-name{position:sticky;left:0;z-index:3;align-self:stretch;display:flex;align-items:center;padding:0 16px;background:#fff;border-right:1px solid var(--line);font-weight:750}.aggregate-demo-stage{height:54px;position:relative;display:grid;place-items:center}.aggregate-demo-stage:before{content:"";position:absolute;left:0;right:0;top:27px;height:1px;background:var(--line-strong)}.aggregate-demo-stage:first-of-type:before{left:50%}.aggregate-demo-stage.last:before{right:50%}.aggregate-demo-stage span{position:absolute;top:4px;color:var(--muted);font-size:8px}.aggregate-demo .aggregate-bead{position:relative;z-index:1;width:18px;height:18px;border-radius:50%;background:var(--composition);box-shadow:0 0 0 1px #fff,0 0 0 2px #aeb7b1}.aggregate-demo .aggregate-bead:after{content:"";position:absolute;inset:5px;border-radius:50%;background:#fff}.aggregate-demo-disclosure{position:sticky;right:0;z-index:4;align-self:stretch;border:0;border-left:1px solid var(--line);background:#fff;color:#68726c;font-size:18px}.aggregate-demo-legend{display:flex;gap:16px;padding:11px 12px;color:var(--muted);font-size:9px}.aggregate-demo-legend span{display:flex;align-items:center;gap:5px}.aggregate-demo-legend i{width:8px;height:8px;border-radius:50%;background:#aeb7b1}.aggregate-demo-legend .complete{background:var(--green)}.aggregate-demo-legend .active{background:var(--ink)}.aggregate-demo-legend .attention{background:var(--attention)}.aggregate-demo-legend .failed{background:var(--danger)}
.axi-validation{padding:18px;min-height:300px}.axi-validation-head{display:flex;align-items:center;gap:8px;margin-bottom:14px}.axi-validation-head button{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 12px;cursor:pointer}.axi-validation-head .play{background:var(--ink);border-color:var(--ink);color:#fff}.axi-validation-head button:disabled{opacity:.4;cursor:default}.axi-validation-summary{margin-left:auto;color:var(--muted);font-size:10px}.axi-progress{height:4px;background:var(--neutral-soft);margin-bottom:14px;overflow:hidden}.axi-progress i{display:block;height:100%;background:var(--ink);transition:width .2s ease}.axi-principles{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));border:1px solid var(--line);border-right:0;border-bottom:0}.axi-principle{min-height:92px;padding:12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff}.axi-principle.running{background:#f7f9f8}.axi-principle.failed{background:var(--danger-soft)}.axi-principle small{display:block;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.05em}.axi-principle strong{display:block;margin-top:9px;font-size:10px;line-height:1.3}.axi-principle span{display:block;margin-top:10px;color:var(--muted);font-size:9px}.axi-principle.passed span{color:var(--green);font-weight:700}.axi-principle.failed span{color:var(--danger);font-weight:700}@media(max-width:900px){.axi-principles{grid-template-columns:repeat(2,minmax(120px,1fr))}}@media(max-width:520px){.axi-validation{padding:12px}.axi-principles{grid-template-columns:1fr}}
</style></head><body><div class="app"><header class="topbar"><div class="identity"><strong>Factorio Workbench</strong><span class="online">Internal</span></div><div class="modes" role="tablist" aria-label="Workbench views"><button class="mode active" role="tab" aria-selected="true" data-source="lab">Harness Lab</button><button class="mode" role="tab" aria-selected="false" data-source="scenario">Scenario</button><button class="mode" role="tab" aria-selected="false" data-source="tests">Tests</button><button class="mode" role="tab" aria-selected="false" data-source="database">Database</button></div><div class="actions"><button class="control" id="previous" hidden>Previous</button><button class="control" id="next" hidden>Next</button><button class="control" id="refresh">Refresh</button><button class="control primary" id="run">Run scenario</button></div></header>
<main class="content"><div class="toolbar"><div class="scenario-copy"><strong id="title">Loading scenario</strong><span id="description"></span></div><select class="picker" id="scenario-picker" aria-label="Choose scenario" hidden></select><select class="picker" id="test-picker" aria-label="Choose test" hidden></select><span class="frame" id="frame"></span></div><div class="workspace" id="workspace"><div class="empty">Loading scenario…</div></div><div class="footer"><div class="legend"><span><i class="key complete"></i>Completed</span><span><i class="key imported"></i>Imported</span><span><i class="key inventory"></i>Inventory</span><span><i class="key current"></i>Current</span><span><i class="key waiting"></i>Awaiting review / needs attention</span><span><i class="key"></i>Pending</span><span><i class="key failed"></i>Failed</span></div><span class="total" id="total"></span></div><details class="inspector"><summary><span>Inspect evidence</span><small id="result"></small></summary><div class="evidence"><section class="panel"><div class="panel-head"><span id="event-label">Receipt stream</span><span>append only</span></div><div id="events"></div></section><section class="panel"><div class="panel-head"><span>Assertions</span><span id="assertion-count"></span></div><div id="checks"></div></section></div></details><div id="error" role="status"></div></main></div>
<script>
${viewerComponentScript}
let source="lab",selected="happy",selectedTest="",scenarios=[],tests=[],testRun=null,frames=[],frame=0,timer,loadVersion=0,lab=null,selectedAttemptId="";
const byId=id=>document.getElementById(id),safe=value=>{const node=document.createElement("span");node.textContent=String(value??"");return node.innerHTML};
async function init(){[scenarios,tests]=await Promise.all([fetch("/api/scenarios").then(r=>r.json()),fetch("/api/tests").then(r=>r.json())]);selectedTest=tests[0]?.id||"";const params=new URLSearchParams(location.search),requested=params.get('scenario');if(requested&&scenarios.some(item=>item.id===requested)){source='scenario';selected=requested;document.querySelectorAll('.mode').forEach(item=>{const active=item.dataset.source==='scenario';item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active))})}renderPickers();byId('scenario-picker').value=selected;byId('scenario-picker').hidden=source!=='scenario';await load();if(params.get('autoplay')==='1'&&selected==='aggregate-polling')aggregatePollingAction('play')}
function renderPickers(){const groups=Object.groupBy(scenarios,item=>item.category||"Other");byId("scenario-picker").innerHTML=Object.entries(groups).map(([category,items])=>'<optgroup label="'+safe(category)+'">'+items.map(item=>'<option value="'+safe(item.id)+'">'+safe(item.name)+'</option>').join("")+'</optgroup>').join("");byId("test-picker").innerHTML=tests.map(item=>'<option value="'+safe(item.id)+'">'+safe(item.category)+' · '+safe(item.name)+'</option>').join("")}
async function load(){clearInterval(timer);const version=++loadVersion;if(source==="tests"){testRun=null;frames=[];renderTest();return}if(source==="lab"){lab=await fetch("/api/mock-lab").then(r=>r.json());if(version===loadVersion)renderLab();return}const data=source==="database"?await fetch("/api/database").then(r=>r.json()):await fetch("/api/scenarios/"+selected).then(r=>r.json());if(version!==loadVersion)return;frames=data.frames||[data];frame=frames.length-1;renderScenario()}
function groups(steps){const result=[];for(const step of steps){const id=step.id.split(".")[0]||"pipeline",last=result.at(-1);if(last?.id===id)last.count++;else result.push({id,label:id,count:1})}return result}
function renderScenario(){const snapshot=frames[frame];if(!snapshot)return;const interactive=["live-execution","cursor-action","local-endpoint","project-removal","aggregate-polling","active-projects","axi-validation","service-recovery"].includes(snapshot.visual?.kind);byId("title").textContent=snapshot.name;byId("description").textContent=snapshot.description;byId("frame").textContent=interactive?"Live temporary state":source==="scenario"?"Frame "+(frame+1)+" / "+frames.length:"Live database";byId("run").hidden=source!=="scenario"||interactive;byId("run").textContent="Run scenario";showFrameControls(source==="scenario"&&!interactive);byId("workspace").innerHTML=scenarioVisual(snapshot);renderEvidence(snapshot);byId("total").textContent=snapshot.visual?.kind==="axi-validation"?"Official 10-principle contract":snapshot.blobs.length+" blob"+(snapshot.blobs.length===1?"":"s")+" · "+snapshot.receipts.length+" receipts";if(snapshot.visual?.kind==="live-execution")wireLiveExecution(snapshot.visual);if(snapshot.visual?.kind==="cursor-action")wireCursorAction();if(snapshot.visual?.kind==="local-endpoint")wireLocalEndpoint();if(snapshot.visual?.kind==="project-removal")wireProjectRemoval();if(snapshot.visual?.kind==="aggregate-polling")wireAggregatePolling();if(snapshot.visual?.kind==="active-projects")wireActiveProjects();if(snapshot.visual?.kind==="axi-validation")wireAxiValidation(snapshot.visual);if(snapshot.visual?.kind==="service-recovery")wireServiceRecovery()}
function scenarioVisual(snapshot){if(snapshot.visual?.kind==="service-recovery")return serviceRecoveryVisual(snapshot);if(snapshot.visual?.kind==="axi-validation")return axiValidationVisual(snapshot.visual);if(snapshot.visual?.kind==="live-execution")return liveExecutionVisual(snapshot);if(snapshot.visual?.kind==="cursor-action")return cursorActionVisual(snapshot);if(snapshot.visual?.kind==="local-endpoint")return localEndpointVisual(snapshot);if(snapshot.visual?.kind==="project-removal")return projectRemovalVisual(snapshot);if(snapshot.visual?.kind==="aggregate-polling")return aggregatePollingVisual();if(snapshot.visual?.kind==="active-projects")return activeProjectsVisual(snapshot.visual);if(snapshot.visual?.kind==="overview-boundary")return overviewBoundaryVisual(snapshot);if(snapshot.visual?.kind==="viewer-resilience")return viewerResilienceVisual(snapshot)+matrix(snapshot)+scenarioEvidence(snapshot);return matrix(snapshot)+scenarioEvidence(snapshot)}
function serviceRecoveryVisual(snapshot){const phases=['ready','lease-lost','restarted','reconciled'],position=phases.indexOf(snapshot.visual.phase),labels=['Healthy unit','Lease lost','Listener closes','Receipt terminal'];return '<section class="endpoint-visual"><div class="endpoint-controls"><button class="play" data-service-recovery="play">Play</button><button data-service-recovery="reset">Reset</button><span>'+safe(snapshot.visual.phase==='stranded'?'Stranded parent · Viewer down':snapshot.visual.phase)+'</span></div><div class="endpoint-flow">'+labels.map((label,index)=>'<div class="endpoint-phase '+(snapshot.visual.phase==='stranded'&&index===2?'current ':index<position?'done ':index===position?'current ':'')+'"><i></i>'+label+'</div>').join('')+'</div>'+matrix(snapshot)+scenarioEvidence(snapshot)+'</section>'}
function wireServiceRecovery(){document.querySelectorAll('[data-service-recovery]').forEach(button=>button.onclick=()=>serviceRecoveryAction(button.dataset.serviceRecovery))}
async function serviceRecoveryAction(action){const response=await fetch('/api/coupled-service-recovery/'+action,{method:'POST'});if(!response.ok)return showScenarioError(await response.json());frames=(await response.json()).frames;frame=0;renderScenario();if(action==='play')startReplay(renderScenario)}
function aggregatePollingVisual(){const progress=[0,25,50,75,100];return '<section class="aggregate-demo"><div class="aggregate-demo-controls"><button class="play" data-aggregate-action="play">Play polling</button><button data-aggregate-action="reset">Reset</button><div class="aggregate-demo-health" id="aggregate-health"><i></i><span>Ready · continuous arcs start at 12 o’clock</span></div></div><div class="aggregate-demo-frame"><div class="aggregate-demo-row" style="grid-template-columns:190px repeat(5,minmax(96px,1fr)) 38px"><div class="aggregate-demo-name">Progress contract</div>'+progress.map((percent,index)=>'<div class="aggregate-demo-stage '+(index===progress.length-1?'last':'')+'"><span>'+percent+'%</span><i class="aggregate-bead" data-aggregate-key="demo::'+index+'" data-aggregate-state="initial" style="--composition:'+demoComposition(index)+'" title="'+percent+'% complete · clockwise from 12 o’clock" aria-label="'+percent+'% complete · clockwise from 12 o’clock"></i></div>').join('')+'<button class="aggregate-demo-disclosure" aria-label="Expand project Progress contract" title="Expand project"><span aria-hidden="true">‹</span></button></div></div><div class="aggregate-demo-legend"><span><i class="complete"></i>Completed arc</span><span><i></i>Neutral remainder</span><span>No separators or spokes</span></div></section>'}
function activeProjectsVisual(visual){return '<section class="active-projects-demo"><div class="active-projects-controls"><button class="play" data-active-action="play">Play refreshes</button><button data-active-action="reset">Reset</button><span id="active-projects-health">7-day meaningful activity · running and attention always visible</span></div><div class="active-projects-table" id="active-projects-table">'+visual.active.map(activeProjectRow).join('')+'<div class="active-projects-fold"><button data-active-action="toggle" aria-expanded="false"><span aria-hidden="true">⌄</span>Show all projects <small>'+visual.inactive.length+'</small></button></div><div data-inactive-projects hidden>'+visual.inactive.map(activeProjectRow).join('')+'</div></div></section>'}
function axiValidationVisual(visual){const passed=visual.principles.filter(item=>item.status==='passed').length,done=visual.principles.filter(item=>item.status==='passed'||item.status==='failed').length;return '<section class="axi-validation"><div class="axi-validation-head"><button class="play" data-axi-action="play" '+(visual.phase==='running'?'disabled':'')+'>Play validation</button><button data-axi-action="reset" '+(visual.phase==='running'?'disabled':'')+'>Reset</button><span class="axi-validation-summary" aria-live="polite">'+safe(visual.phase==='ready'?'Ready · 10 actual CLI checks':visual.phase==='running'?done+' / 10 checked':passed+' / 10 passed')+'</span></div><div class="axi-progress" role="progressbar" aria-label="AXI principles passed" aria-valuemin="0" aria-valuemax="10" aria-valuenow="'+passed+'"><i style="width:'+passed*10+'%"></i></div><div class="axi-principles">'+visual.principles.map(axiPrinciple).join('')+'</div></section>'}
function axiPrinciple(item){const detail=item.status==='pending'?'Waiting':item.status==='running'?'Running actual test':item.status==='passed'?'Passed · '+item.durationMs+' ms':'Failed';return '<article class="axi-principle '+safe(item.status)+'" title="'+safe(item.test)+'"><small>Principle '+item.index+'</small><strong>'+safe(item.name)+'</strong><span>'+safe(detail)+'</span></article>'}
function wireAxiValidation(visual){document.querySelectorAll('[data-axi-action]').forEach(button=>button.onclick=()=>axiValidationAction(button.dataset.axiAction));if(visual.phase==='running')timer=setTimeout(load,150)}
async function axiValidationAction(action){const response=await fetch('/api/axi-validation/'+action,{method:'POST'});if(!response.ok)return showScenarioError(await response.json());const data=await response.json();frames=data.frames;frame=0;renderScenario()}
function activeProjectRow(project){const stages=['Plan','Build','Review','Done'];return '<section class="active-project-card" data-active-project="'+safe(project.id)+'"><div class="active-project-head"><b>'+safe(project.name)+'</b><span>'+project.blobs.length+' task'+(project.blobs.length===1?'':'s')+'</span><div class="active-project-track">'+stages.map((stage,index)=>'<i class="'+activeProjectStage(project,index)+'" title="'+safe(stage)+'"></i>').join('')+'</div><span class="active-project-chevron" aria-hidden="true">‹</span></div>'+project.blobs.map((blob,index)=>'<div class="active-project-task"><span>'+safe(blob.title)+'</span><div class="active-task-track">'+stages.map((stage,step)=>'<i class="'+(step<index%4?'done ':step===index%4?'current ':'')+(blob.status==='waiting'&&step===index%4?'attention':'')+'" title="'+safe(stage+' · '+blob.status)+'"></i>').join('')+'</div><small>'+safe(blob.status)+'</small></div>').join('')+(project.blobs.length?'':'<div class="active-project-empty">No tasks</div>')+'</section>'}
function activeProjectStage(project,index){if(!project.blobs.length)return 'pending';const completed=project.blobs.filter(blob=>blob.status==='complete').length;return index===0&&completed===project.blobs.length?'done':index===0?'current':'pending'}
let activeProjectRefreshTimer=null,activeProjectRefreshes=0;
function wireActiveProjects(){document.querySelectorAll('[data-active-action]').forEach(button=>button.onclick=()=>activeProjectsAction(button.dataset.activeAction))}
function activeProjectsAction(action){if(action==='toggle'){const hidden=byId('active-projects-table').querySelector('[data-inactive-projects]'),button=byId('active-projects-table').querySelector('[data-active-action="toggle"]'),show=hidden.hidden;hidden.hidden=!show;button.setAttribute('aria-expanded',String(show));button.innerHTML='<span aria-hidden="true">'+(show?'⌃':'⌄')+'</span>'+(show?'Hide inactive projects':'Show all projects')+' <small>'+hidden.children.length+'</small>';return}if(action==='reset'){clearInterval(activeProjectRefreshTimer);activeProjectRefreshes=0;byId('active-projects-health').textContent='7-day meaningful activity · running and attention always visible';return}clearInterval(activeProjectRefreshTimer);const projects=[...document.querySelectorAll('[data-active-project]')];activeProjectRefreshTimer=setInterval(()=>{activeProjectRefreshes++;const stable=projects.every((node,index)=>node===document.querySelectorAll('[data-active-project]')[index]);byId('active-projects-health').textContent=activeProjectRefreshes+' refreshes · '+(stable?'same project nodes · fold preserved':'node replaced');if(activeProjectRefreshes>=6)clearInterval(activeProjectRefreshTimer)},500)}
function demoComposition(index){return aggregateProgressGradient(index,4)}
function demoLabel(stage,index){return index*25+'% complete · continuous clockwise arc from 12 o’clock'}
function wireAggregatePolling(){document.querySelectorAll('[data-aggregate-action]').forEach(button=>button.onclick=()=>aggregatePollingAction(button.dataset.aggregateAction))}
function aggregatePollingAction(action){clearInterval(timer);if(action==='reset')return renderScenario();const nodes=[...document.querySelectorAll('.aggregate-demo [data-aggregate-key]')],health=byId('aggregate-health');let polls=0;health.classList.add('stable');timer=setInterval(()=>{polls++;nodes.forEach((node,index)=>updateAggregateMarker(node,{signature:'stable-'+index,composition:demoComposition(index),label:demoLabel('',index),total:4}));const same=nodes.every((node,index)=>node===document.querySelector('[data-aggregate-key="demo::'+index+'"]'));health.innerHTML='<i></i><span>'+polls+' refresh'+(polls===1?'':'es')+' · '+(same?'same marker nodes · no redraw':'node replaced')+'</span>';if(polls>=6)clearInterval(timer)},500)}
function projectRemovalVisual(snapshot){const data=snapshot.visual,removed=data.phase==="removed";return '<section class="removal-visual"><div class="removal-controls"><button class="remove" data-removal-action="remove" '+(removed?'disabled':'')+'>Remove exact project</button><button data-removal-action="reset">Reset</button><span>'+(removed?'Removed with evidence':'Preview only · nothing removed')+'</span></div><div class="removal-scope"><div class="removal-fact"><small>Exact project</small><b>'+safe(data.preview.projectName)+'</b></div><div class="removal-fact"><small>Blobs</small><b>'+data.preview.blobCount+'</b></div><div class="removal-fact"><small>Receipts</small><b>'+data.preview.receiptCount+'</b></div><div class="removal-fact"><small>Confirmation</small><b>'+safe(data.preview.confirmation)+'</b></div></div><div class="removal-result">'+(removed?'Project graph removed · '+data.auditCount+' durable removal record':'Remove applies this exact preview with explicit evidence.')+'</div></section>'}
function wireProjectRemoval(){document.querySelectorAll('[data-removal-action]').forEach(button=>button.onclick=()=>projectRemovalAction(button.dataset.removalAction))}
async function projectRemovalAction(action){const response=await fetch('/api/project-removal/'+action,{method:'POST'});const data=await response.json();if(!response.ok)return showScenarioError(data);frames=data.frames;frame=0;renderScenario()}
function overviewBoundaryVisual(snapshot){const data=snapshot.visual;return '<section class="overview-boundary"><div class="boundary-state '+data.phase+'"><b>'+(data.phase==="leaked"?'Before · boundary broken':'After · boundary enforced')+'</b><span>'+(data.phase==="leaked"?'Internal diagnostics appear before the actual work.':'Overview begins directly with projects and task beads.')+'</span></div>'+(data.diagnosticHtml||'')+'<div class="boundary-pipeline">'+matrix(snapshot)+'</div></section>'}
function viewerResilienceVisual(snapshot){return '<section class="resilience-projects" aria-label="Viewer project health">'+snapshot.visual.projects.map(project=>'<div class="resilience-project '+(project.issue?'unavailable':'healthy')+'"><div><b>'+safe(project.name)+'</b><span>'+project.taskCount+' task'+(project.taskCount===1?'':'s')+'</span></div>'+(project.issue?'<strong title="'+safe(project.issue.detail)+'">'+safe(project.issue.summary)+'</strong><small>This project is isolated until its pipeline path is restored.</small>':'<strong>Pipeline '+safe(project.pipeline||'available')+'</strong><small>Healthy project remains usable.</small>')+'</div>').join('')+'</section>'}
function cursorActionVisual(snapshot){const data=snapshot.visual;const resultClass=data.lastResult.startsWith('Failed:')?' failure':'';return '<section class="cursor-action-visual"><div class="cursor-action-controls"><button class="play" data-cursor-scenario="play">Play default Open</button><button data-cursor-scenario="reset">Reset</button><span>Default opener · '+safe(data.openerLabel)+' · '+data.calls+' launch attempt'+(data.calls===1?'':'s')+'</span></div>'+data.rows.map(row=>'<div class="cursor-action-row"><div>'+row.triggerHtml+'<small>'+safe(row.workspaceKind)+'</small></div><code>'+safe(row.root)+'</code></div>').join('')+'<div class="cursor-action-result'+resultClass+'">'+safe(data.lastResult)+'</div>'+data.menuHtml+scenarioEvidence(snapshot)+'</section>'}
function wireCursorAction(){document.querySelectorAll('[data-cursor-scenario]').forEach(button=>button.onclick=()=>cursorScenarioAction(button.dataset.cursorScenario));document.querySelectorAll('.cursor-action-visual [data-blob-menu]').forEach(button=>button.onclick=event=>openCursorMenu(event.currentTarget))}
function openCursorMenu(trigger){const row=frames[frame].visual.rows.find(item=>item.id===trigger.dataset.blobMenu),menu=byId('blob-menu');menu.innerHTML='<button role="menuitem" data-cursor-open="'+safe(row.id)+'" '+(row.action.enabled?'':'disabled')+'>Open</button>'+(row.action.enabled?'':'<small>'+safe(row.action.explanation)+'</small>');menu.hidden=false;const box=trigger.getBoundingClientRect(),menuBox=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(box.left,innerWidth-menuBox.width-8))+'px';menu.style.top=Math.min(innerHeight-menuBox.height-8,box.bottom+5)+'px';const item=menu.querySelector('[role="menuitem"]');item.onclick=()=>{closeCursorMenu();cursorScenarioOpen(row.id)};item.onkeydown=event=>{if(event.key==='Escape'){closeCursorMenu();trigger.focus()}};item.focus()}
function closeCursorMenu(){const menu=byId('blob-menu');if(!menu)return;menu.hidden=true;menu.innerHTML=''}
async function cursorScenarioAction(action){const response=await fetch('/api/cursor-action/'+action,{method:'POST'});if(!response.ok)return showScenarioError(await response.json());frames=(await response.json()).frames;frame=0;renderScenario()}
async function cursorScenarioOpen(blobId){const response=await fetch('/api/cursor-action/open/'+encodeURIComponent(blobId),{method:'POST'});if(!response.ok)return showScenarioError(await response.json());frames=(await response.json()).frames;frame=0;renderScenario()}
function showScenarioError(result){byId('error').textContent=result.error||'Scenario action failed.'}
function localEndpointVisual(snapshot){const data=snapshot.visual,order=['ready','committed','startup-timeout','healthy','receipt-ended','stable','child-lost','recovered','stopped'],labels=['Ready','Receipt runs','Old deadline','Endpoint healthy','Awaiting decision','Poll stays stable','Child exits','Poll recovers','Owned stop'],mapped={"exit-received-url":"healthy","service-restarting":"receipt-ended",approved:"receipt-ended",rejected:"receipt-ended",churn:"stable"}[data.phase]||data.phase,position=order.indexOf(mapped),endpoint=data.endpoint,lease=data.lease,waiting=['receipt-ended','stable','child-lost','recovered'].includes(mapped),phase=data.phase==='churn'?'Churn detected':data.phase==='stable'?'Stable owner reused':data.phase;return '<section class="endpoint-visual"><div class="endpoint-controls"><button class="play" data-endpoint-action="play">Play</button><button data-endpoint-action="recover" '+(!lease||lease.desiredState!=='active'?'disabled':'')+'>Lose child + recover</button><button data-endpoint-action="restart" '+(!lease||lease.desiredState!=='active'?'disabled':'')+'>Restart service</button><button data-endpoint-action="approve" '+(!waiting?'disabled':'')+'>Approve</button><button data-endpoint-action="reject" '+(!waiting?'disabled':'')+'>Reject</button><button data-endpoint-action="reset">Reset</button><span>'+safe(phase)+'</span></div><div class="endpoint-flow">'+labels.map((label,index)=>'<div class="endpoint-phase '+(index<position?'done ':index===position?'current ':'')+'"><i></i>'+label+'</div>').join('')+'</div><div class="endpoint-facts"><div class="endpoint-fact"><small>Declared command</small><code>'+safe(data.command+' '+data.args.join(' '))+'</code></div><div class="endpoint-fact"><small>Assigned workspace</small><code>'+safe(data.workspace)+'</code></div><div class="endpoint-fact"><small>Exact Git head</small><code>'+safe(data.head)+'</code></div><div class="endpoint-fact"><small>Local endpoint</small><b>'+(endpoint?safe(endpoint.url)+' · '+(endpoint.alive?'serving':'stopped'):'Not started')+'</b></div><div class="endpoint-fact"><small>Durable process lease</small><b>'+(lease?safe(lease.ownership+' · desired '+lease.desiredState+' · observed '+lease.observedState):'none')+'</b></div></div>'+matrix(snapshot)+scenarioEvidence(snapshot)+'</section>'}
function wireLocalEndpoint(){const controls=document.querySelector('.endpoint-controls');if(controls&&!controls.querySelector('[data-endpoint-action="poll"]')){const poll=document.createElement('button');poll.dataset.endpointAction='poll';poll.textContent='Poll stability';controls.querySelector('[data-endpoint-action="recover"]')?.before(poll)}document.querySelectorAll('[data-endpoint-action]').forEach(button=>button.onclick=()=>localEndpointAction(button.dataset.endpointAction))}
async function localEndpointAction(action){byId('error').textContent='';const response=await fetch('/api/local-endpoint/'+action,{method:'POST'});if(!response.ok)return showScenarioError(await response.json());frames=(await response.json()).frames;frame=action==='play'?0:frames.length-1;renderScenario();if(action==='play')startReplay(renderScenario)}
function scenarioEvidence(snapshot){const visual=snapshot.visual?.kind==="live-execution"?liveExecutionVisual(snapshot.visual):"",cards=snapshot.evidenceCards?.length?'<details class="scenario-debug"><summary>Exact evidence · argv, paths and JSON</summary><div class="evidence-grid">'+snapshot.evidenceCards.map(card=>evidenceCard(card.label,"",card.value,card.label.includes("argv"))).join("")+"</div></details>":"";return visual+cards}
function liveExecutionVisual(snapshot){const data=snapshot.visual,log=data.timeline.slice(-5).map(item=>'<span>#'+item.id+" · "+safe(item.label)+'</span>').join("");return '<section class="live-scenario"><div class="live-scenario-controls"><button class="play" data-live-action="play" '+(data.playEnabled?"":"disabled")+'>Play</button><button data-live-action="reset">Reset</button><span>'+safe(data.phase)+'</span></div><div class="live-conveyor">'+matrix(snapshot)+'</div><div class="live-details">'+data.executionOverviewHtml+'<div class="activity-log">'+(log||"<span>Play to run one transition through the real runner.</span>")+"</div></div></section>"}
function wireLiveExecution(data){document.querySelectorAll("[data-live-action]").forEach(button=>button.onclick=()=>liveExecutionAction(button.dataset.liveAction));if(data.phase==="queued"||data.phase==="running")timer=setTimeout(load,250)}
async function liveExecutionAction(action){byId("error").textContent="";const response=await fetch("/api/live-execution/"+action,{method:"POST"});if(!response.ok){const error=await response.json().catch(()=>({error:"Live scenario action failed."}));byId("error").textContent=error.error;return}const data=await response.json();frames=data.frames;frame=0;renderScenario()}
function matrix(snapshot){const steps=snapshot.steps,bands=groups(steps),rows=snapshot.blobs.length?snapshot.blobs.map(blob=>taskRow(blob,steps)).join(""):'<div class="empty">No blobs in this database.</div>';return '<div class="matrix" style="--steps:'+Math.max(steps.length,1)+'"><div class="matrix-head" style="--steps:'+Math.max(steps.length,1)+'"><div class="corner"></div>'+bands.map(group=>'<div class="band" style="grid-column:span '+group.count+'">'+safe(group.label)+'</div>').join("")+steps.map(step=>'<div class="step">'+safe(step.label)+'</div>').join("")+'</div><section class="project"><div class="project-head"><span>'+safe(source==="database"?"Database state":"Scenario state")+'</span><span class="count">'+snapshot.blobs.length+'</span></div><div class="taskrows">'+rows+'</div></section></div>'}
function taskRow(blob,steps){const current=steps.findIndex(step=>step.id===blob.stepId),complete=blob.stepId==="complete"||blob.state==="complete",cells=steps.map((step,index)=>{const done=complete||index<current,isCurrent=!complete&&index===current,classes=["bead",done?"done":"",isCurrent?"current":"",isCurrent?blob.state:""].filter(Boolean).join(" ");return '<div class="track-cell '+(index===0?"first ":"")+(index===steps.length-1?"last":"")+'"><i class="'+classes+'"></i></div>'}).join("");const label=statusLabel(blob.state);return '<div class="taskrow" style="--steps:'+Math.max(steps.length,1)+'"><div class="task-title" title="'+safe(blob.id)+'"><span class="task-name">'+safe(blob.title)+'</span>'+(label?'<small class="task-status '+safe(blob.state)+'">'+safe(label)+'</small>':"")+'</div>'+cells+'</div>'}
function statusLabel(status){return {ready:"Ready",queued:"Queued",running:"Running",retry:"Retry",advanced:"Advanced",waiting:"Awaiting review",blocked:"Needs attention",failed:"Failed",held:"Inventory"}[status]||""}
function renderEvidence(snapshot){byId("event-label").textContent="Receipt stream";byId("events").innerHTML=snapshot.receipts.length?snapshot.receipts.slice().reverse().map(receipt=>'<div class="event"><span>'+safe(receipt.at)+'</span><b>'+safe(receipt.stepId)+'</b><b class="'+(receipt.status==="failed"?"fail":"")+'">'+safe(receipt.status)+'</b><span>'+safe(receipt.detail)+'</span></div>').join(""):'<div class="empty">No receipts yet.</div>';byId("checks").innerHTML=snapshot.assertions.length?snapshot.assertions.map(assertion=>'<div class="check"><b class="'+(assertion.passed?"pass":"fail")+'">'+(assertion.passed?"✓":"×")+'</b> '+safe(assertion.label)+'</div>').join(""):'<div class="empty">Read-only database view.</div>';const passed=snapshot.assertions.filter(item=>item.passed).length;byId("assertion-count").textContent=snapshot.assertions.length?passed+" / "+snapshot.assertions.length:"";byId("result").textContent=snapshot.assertions.length&&passed===snapshot.assertions.length?"All assertions pass":""}
function renderLab(){
  const latest=lab.attempts.at(-1),receipt=latest?.receipt;
  const snapshot={name:lab.name,description:lab.description,steps:lab.steps,blobs:[{
    id:lab.blob.id,title:lab.blob.title,
    state:lab.blob.paused?(receipt?.status==="failed"?"failed":"waiting"):(receipt?.status==="running"?"running":"ready"),
    stepId:lab.blob.state,
  }],receipts:lab.receipts,assertions:lab.assertions};
  byId("scenario-picker").hidden=true;byId("test-picker").hidden=true;
  byId("title").textContent=lab.name;byId("description").textContent=lab.description;
  byId("frame").textContent="Temporary DB · deterministic harness";byId("run").hidden=true;showFrameControls(false);
  byId("workspace").innerHTML=learningToolbar()+matrix(snapshot)+learningPanels();
  byId("event-label").textContent="Append-only execution evidence";
  byId("events").innerHTML=lab.events.length?lab.events.slice().reverse().map(renderHarnessEvent).join(""):'<div class="empty">Run Step to create lifecycle events.</div>';
  byId("checks").innerHTML=lab.assertions.map(item=>'<div class="check"><b class="'+(item.passed?"pass":"fail")+'">'+(item.passed?"✓":"×")+'</b> '+safe(item.label)+'</div>').join("")+'<div class="check">'+lab.attempts.length+' attempts · '+lab.events.length+' events · '+lab.humanInputs.length+' human inputs</div>';
  byId("assertion-count").textContent=lab.assertions.filter(item=>item.passed).length+" / "+lab.assertions.length;
  byId("result").textContent="Workbench-only mock proof";byId("total").textContent="blob r"+lab.blob.revision.revision+" · "+lab.attempts.length+" attempts";
  wireLearningControls();
}
function learningToolbar(){
  const options=lab.scenarioCatalog.map(item=>'<option value="'+safe(item.id)+'" '+(item.id===lab.selectedScenario?"selected":"")+'>'+safe(item.category+" · "+item.name)+'</option>').join("");
  return '<div class="learning-toolbar"><button class="step-primary" data-lab-action="step">Step</button><button class="play-secondary" data-lab-action="play">Play continuously</button><button class="quiet-action" data-lab-action="stop">Stop</button><button class="quiet-action" data-lab-action="rewind-step">Rewind + Step</button><button class="quiet-action" data-lab-action="restart">Restart DB</button><button class="quiet-action" data-lab-action="reset">Reset</button><select id="learning-scenario" aria-label="Choose learning scenario">'+options+'</select></div>';
}
function learningPanels(){
  return '<div class="learning-layout"><section class="learning-panel"><h3>Attempts <small>append only</small></h3><div class="attempt-list">'+attemptCards()+'</div><div class="scenario-note">'+safe(lab.scenarioCatalog.find(item=>item.id===lab.selectedScenario)?.description||"")+'</div></section><section class="learning-panel"><h3>Complete attempt <small>input → decision</small></h3>'+attemptInspector()+'</section>'+comparisonPanel()+'</div>'+editorPanels();
}
function attemptCards(){
  if(!lab.attempts.length)return '<div class="empty">No attempts yet. Run Step.</div>';
  return lab.attempts.slice().reverse().map((attempt,index)=>{
    const receipt=attempt.receipt,isSelected=receipt.id===(selectedAttemptId||lab.attempts.at(-1)?.receipt.id),classes=["attempt-card",isSelected?"current":"",receipt.invalidatedAt?"invalidated":""].filter(Boolean).join(" ");
    return '<button class="'+classes+'" data-attempt-id="'+safe(receipt.id)+'"><b>#'+receipt.attempt+" · "+safe(receipt.stepId)+" · "+safe(receipt.status)+'</b><span>blob r'+attempt.blobRevision.revision+" · "+shortHash(attempt.definition.contentHash)+(receipt.invalidatedAt?" · superseded":" · current")+"</span></button>";
  }).join("");
}
function attemptInspector(){
  const attempt=lab.attempts.find(item=>item.receipt.id===selectedAttemptId)||lab.attempts.at(-1);if(!attempt)return '<div class="empty">The complete evidence packet appears after one Step.</div>';
  const receipt=attempt.receipt,events=lab.events.filter(event=>attempt.eventIds.includes(event.id));
  return '<div class="attempt-detail"><div class="evidence-grid">'+
    evidenceCard("Blob input snapshot","r"+attempt.blobRevision.revision+" · "+shortHash(attempt.blobRevision.contentHash),attempt.inputSnapshot.title+"\\n"+attempt.inputSnapshot.body+"\\n"+attempt.inputSnapshot.inputArtifacts.join("\\n"),true)+
    evidenceCard("Harness / model",attempt.harness+" / "+attempt.model,"run "+(attempt.externalRunId||"none"),false)+
    evidenceCard("Entry Markdown",shortHash(attempt.definition.gitSha)+" / "+shortHash(attempt.definition.contentHash),attempt.definition.entry,true)+
    evidenceCard("Exit Markdown",shortHash(attempt.definition.gitSha)+" / "+shortHash(attempt.definition.contentHash),attempt.definition.exit,true)+
    evidenceCard("Decision",receipt.invalidatedAt?"superseded "+attempt.decision:attempt.decision,attempt.reason||"No reason",false)+
    evidenceCard("Metrics",(attempt.elapsedMs??"n/a")+" ms",(attempt.inputTokens??"n/a")+" input · "+(attempt.outputTokens??"n/a")+" output tokens",false)+
    evidenceCard("Output artifacts",attempt.outputArtifacts.length+" refs",attempt.outputArtifacts.join("\\n")||"none",true)+
    evidenceCard("Lifecycle events",events.length+" append-only events",events.map(event=>"#"+event.id+" "+event.name.replace("axi_factorio.harness.","")+" "+JSON.stringify(event.attributes)).join("\\n"),true)+
  '</div></div>';
}
function evidenceCard(label,value,detail,wide){
  return '<div class="evidence-card '+(wide?"wide":"")+'"><small>'+safe(label)+'</small><b>'+safe(value)+'</b><pre>'+safe(detail)+'</pre></div>';
}
function comparisonPanel(){
  if(lab.attempts.length<2)return "";
  const pair=lab.attempts.slice(-2);
  return '<section class="comparison"><h3>Compare attempts <small>exact provenance</small></h3><div class="comparison-grid">'+pair.map(compareAttempt).join("")+'</div></section>';
}
function compareAttempt(attempt){
  const receipt=attempt.receipt;
  return '<div class="comparison-attempt"><b>#'+receipt.attempt+" · "+safe(receipt.invalidatedAt?"superseded":attempt.decision)+'</b><p>Blob r'+attempt.blobRevision.revision+' <span class="hash">'+safe(shortHash(attempt.blobRevision.contentHash))+'</span><br>Prompt <span class="hash">'+safe(shortHash(attempt.definition.contentHash))+'</span><br>'+safe((attempt.elapsedMs??"n/a")+" ms · "+(attempt.inputTokens??"n/a")+"/"+(attempt.outputTokens??"n/a")+" tokens")+'</p><details><summary>Input and prompts</summary><pre>'+safe(attempt.inputSnapshot.body+"\\n\\nENTRY\\n"+attempt.definition.entry+"\\n\\nEXIT\\n"+attempt.definition.exit)+'</pre></details></div>';
}
function editorPanels(){
  const prompt=lab.editor.kind==="prompt"&&lab.editor.promptKind==="exit"?lab.currentDefinition.exit:lab.currentDefinition.entry;
  return '<div class="editors"><section class="editor"><h3>Edit blob · current r'+lab.blob.revision.revision+'</h3><textarea id="blob-editor">'+safe(lab.editor.kind==="blob"?lab.editor.after:lab.blob.body)+'</textarea><div class="editor-actions"><button class="quiet-action" data-edit-action="blob-preview">Preview diff</button><button class="step-primary" data-edit-action="blob-save" '+(!(lab.editor.kind==="blob"&&lab.editor.valid)||lab.editor.saved?"disabled":"")+'>Save revision</button><button class="quiet-action" data-edit-action="cancel">Cancel</button></div>'+editorDiff("blob")+'</section><section class="editor"><h3>Edit real pipeline Markdown</h3><select id="prompt-kind"><option value="entry" '+(lab.editor.promptKind==="exit"?"":"selected")+'>Entry</option><option value="exit" '+(lab.editor.promptKind==="exit"?"selected":"")+'>Exit</option></select><textarea id="prompt-editor">'+safe(lab.editor.kind==="prompt"?lab.editor.after:prompt)+'</textarea><div class="editor-actions"><button class="quiet-action" data-edit-action="prompt-preview">Preview diff</button><button class="step-primary" data-edit-action="prompt-save" '+(!(lab.editor.kind==="prompt"&&lab.editor.valid)||lab.editor.saved?"disabled":"")+'>Save Markdown</button><button class="quiet-action" data-edit-action="cancel">Cancel</button></div>'+editorDiff("prompt")+'</section></div>';
}
function editorDiff(kind){
  if(lab.editor.kind!==kind)return "";
  const rows=lab.editor.diff.map(line=>'<div class="diff-line '+line.kind+'">'+safe((line.kind==="add"?"+ ":line.kind==="remove"?"- ":"  ")+line.text)+'</div>').join("");
  return (lab.editor.error?'<div class="validation-error">'+safe(lab.editor.error)+'</div>':'')+(rows?'<div class="diff-view">'+rows+'</div>':'');
}
function renderHarnessEvent(event){return '<div class="event"><span>#'+event.id+'</span><b>'+safe(event.stepId)+'</b><b>'+safe(event.name.replace("axi_factorio.harness.",""))+'</b><span>'+safe(JSON.stringify(event.attributes))+'</span></div>'}
function shortHash(value){return value?String(value).slice(0,10)+"…":"none"}
function wireLearningControls(){
  document.querySelectorAll("[data-lab-action]").forEach(button=>button.onclick=()=>labAction(button.dataset.labAction));
  document.querySelectorAll("[data-edit-action]").forEach(button=>button.onclick=()=>editAction(button.dataset.editAction));
  document.querySelectorAll("[data-attempt-id]").forEach(button=>button.onclick=()=>{selectedAttemptId=button.dataset.attemptId;renderLab()});
  byId("learning-scenario").onchange=event=>selectLearningScenario(event.target.value);
  byId("prompt-kind").onchange=event=>{byId("prompt-editor").value=event.target.value==="exit"?lab.currentDefinition.exit:lab.currentDefinition.entry};
}
async function labAction(action){await updateLab("/api/mock-lab/"+action,{});if(action==="play")scheduleLabRefresh()}
async function selectLearningScenario(id){await updateLab("/api/mock-lab/scenario/"+encodeURIComponent(id),{})}
async function editAction(action){
  if(action==="cancel")return updateLab("/api/mock-lab/edit/cancel",{});
  if(action==="blob-preview")return updateLab("/api/mock-lab/blob/preview",{body:byId("blob-editor").value});
  if(action==="blob-save")return updateLab("/api/mock-lab/blob/save",{});
  if(action==="prompt-preview")return updateLab("/api/mock-lab/prompt/preview",{kind:byId("prompt-kind").value,content:byId("prompt-editor").value});
  if(action==="prompt-save")return updateLab("/api/mock-lab/prompt/save",{});
}
async function updateLab(path,body){
  byId("error").textContent="";
  const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  if(!response.ok){const error=await response.json().catch(()=>({error:"Workbench action failed."}));byId("error").textContent=error.error;return}
  lab=await response.json();renderLab();
}
function scheduleLabRefresh(){[200,500,900].forEach(delay=>setTimeout(async()=>{if(source!=="lab")return;lab=await fetch("/api/mock-lab").then(response=>response.json());renderLab()},delay))}
function renderTest(){const test=tests.find(item=>item.id===selectedTest);if(!test)return;const current=testRun?.frames[frame];byId("title").textContent=test.name;byId("description").textContent=test.visualDescription;byId("frame").textContent=current?"Frame "+(frame+1)+" / "+testRun.frames.length:test.visualLabel;byId("run").hidden=false;byId("run").textContent=testRun?"Replay test":"Run actual test";showFrameControls(Boolean(testRun));byId("workspace").innerHTML=renderProof(test,current);byId("events").innerHTML=renderTestEvents(current);byId("checks").innerHTML=renderTestChecks(current);byId("total").textContent=test.category+" · "+test.file;byId("assertion-count").textContent=current?.status||"";byId("result").textContent=current?.status==="passed"?"Test passes":current?.status==="failed"?"Test failed":""}
function renderProof(test,current){const labels={"terminal-proof":["Test invoked","TAP assertion","Exit proof"],"service-timeline":["Lease acquired","Service events","Disposition"],"conveyor-replay":["Blob created","Receipt events","Final state"]}[test.visualKind],point=current?.status==="passed"?2:current?.events.length?1:0;return '<div class="visual-proof"><strong>'+safe(current?.label||"Visual contract")+'</strong><div class="proof-map">'+labels.map((label,index)=>'<div class="proof-node '+(current?.status==="passed"&&index<=point?"done":index<point?"done":index===point?"current":"")+'"><i></i>'+safe(label)+'</div>').join("")+'</div><p>'+safe(test.visualDescription)+'</p></div>'}
function renderTestEvents(current){if(!current)return '<div class="empty">Run the actual test to collect evidence.</div>';return current.events.length?current.events.slice().reverse().map(event=>'<div class="event"><b>'+safe(event.event)+'</b><span>'+safe(event.status)+'</span><span>'+safe(event.detail)+'</span></div>').join(""):current.transcript.map(line=>'<div class="check">'+safe(line)+'</div>').join("")}
function renderTestChecks(current){if(!current)return '<div class="empty">Actual Node test · exact name filter.</div>';const finished=current.status!=="running";return '<div class="check"><b class="'+(current.status==="failed"?"fail":"pass")+'">'+(finished?(current.status==="passed"?"✓":"×"):"·")+'</b> '+safe(current.label)+'</div>'+(finished?'<div class="check">'+testRun.durationMs+' ms · exit '+testRun.exitCode+'</div>':"")}
async function run(){if(source!=="tests"){startReplay(renderScenario);return}if(testRun){startReplay(renderTest);return}byId("run").disabled=true;try{const response=await fetch("/api/tests/"+encodeURIComponent(selectedTest)+"/run",{method:"POST"});if(!response.ok)throw new Error(await response.text());testRun=await response.json();frames=testRun.frames;frame=0;renderTest();startReplay(renderTest)}finally{byId("run").disabled=false}}
function startReplay(renderer){clearInterval(timer);frame=0;renderer();timer=setInterval(()=>{if(frame>=frames.length-1)return clearInterval(timer);frame++;renderer();byId("workspace").classList.add("pulse");setTimeout(()=>byId("workspace").classList.remove("pulse"),400)},650)}
function showFrameControls(show){byId("previous").hidden=!show;byId("next").hidden=!show;byId("previous").disabled=frame<=0;byId("next").disabled=frame>=frames.length-1}
function moveFrame(delta){clearInterval(timer);frame=Math.max(0,Math.min(frames.length-1,frame+delta));source==="tests"?renderTest():renderScenario()}
function selectSource(button){source=button.dataset.source;document.querySelectorAll(".mode").forEach(item=>{const selected=item===button;item.classList.toggle("active",selected);item.setAttribute("aria-selected",String(selected))});byId("scenario-picker").hidden=source!=="scenario";byId("test-picker").hidden=source!=="tests";load()}
document.querySelectorAll(".mode").forEach(button=>button.onclick=()=>selectSource(button));byId("scenario-picker").onchange=event=>{selected=event.target.value;load()};byId("test-picker").onchange=event=>{selectedTest=event.target.value;testRun=null;renderTest()};byId("run").onclick=run;byId("refresh").onclick=load;byId("previous").onclick=()=>moveFrame(-1);byId("next").onclick=()=>moveFrame(1);init();
</script></body></html>`;

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import { FactorioDatabase } from "./Database.ts";
import { ConveyorStore } from "./Store.ts";
import type { Blob, Receipt } from "./Types.ts";
import { discoverPipeline } from "./Pipeline.ts";
import type { TestHarness } from "../test/harness/CreateTestHarness.ts";
import { getVisualTest, listVisualTests, runVisualTest } from "../test/visual/TestCatalog.ts";
import { workbenchPort } from "./WorkbenchPort.ts";
import { MockHarnessLab, type LabAction } from "../test/harness/MockHarnessLab.ts";
import { LiveExecutionScenario } from "../test/harness/LiveExecutionScenario.ts";
import { CursorActionScenario } from "../test/harness/CursorActionScenario.ts";
import { LocalEndpointScenario } from "../test/harness/LocalEndpointScenario.ts";
import { ProjectRemovalScenario } from "../test/harness/ProjectRemovalScenario.ts";
import { AxiValidationScenario, type AxiValidationVisual } from "../test/harness/AxiValidationScenario.ts";
import { CoupledServiceRecoveryScenario } from "../test/harness/CoupledServiceRecoveryScenario.ts";
import { executionOverviewMarkup, liveExecutionStyles } from "./LiveExecutions.ts";
import { viewerComponentScript } from "./ViewerComponents.ts";
