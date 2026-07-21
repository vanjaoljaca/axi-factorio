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
  visual?: LiveExecutionVisual | ViewerResilienceVisual | CursorActionVisual | ReviewServerVisual;
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
    actionHtml: string;
  }>;
  lastResult: string;
  calls: number;
};
type ReviewServerVisual = {
  kind: "review-server";
  phase: "ready" | "committed" | "healthy" | "exit-received-url" | "stopped";
  workspace: string;
  head: string;
  server: { url: string; cwd: string; gitHead: string; pid: number; command: string; args: string[]; alive: boolean } | null;
};

const port = workbenchPort(process.argv);
const databasePath = resolve(argument("--db") ?? "pipelines/axi-factorio.db");
const mockLab = new MockHarnessLab();
const liveExecutionScenario = new LiveExecutionScenario();
const cursorActionScenario = new CursorActionScenario();
const reviewServerScenario = new ReviewServerScenario();
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
    if (url.pathname === "/api/review-server/play" && request.method === "POST") {
      return json(response, await reviewServerScenario.play());
    }
    if (url.pathname === "/api/review-server/reset" && request.method === "POST") {
      return json(response, reviewServerScenario.reset());
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
    reviewServerScenario.dispose();
    void liveExecutionScenario.dispose().finally(() => server.close(() => process.exit(0)));
  });
}

function scenarioIndex(): object[] {
  return [
    {
      id: "happy", name: "Default happy path",
      description: "Real runner · fresh SQLite · test/harness/default",
    },
    {
      id: "codex-active-turn", name: "Active Codex reconciliation",
      description: "notLoaded container · fresh active turn · production receipt path",
    },
    {
      id: "codex-mcp-isolation", name: "Pinned Codex MCP isolation",
      description: "0.144.6 argv contract · unrelated MCP failure · production receipt path",
    },
    {
      id: "codex-writable-continuation", name: "Writable Codex continuation",
      description: "entry retry · same-task continuation · exit advance · durable artifact",
    },
    {
      id: "blob-workspace-relocation", name: "Blob workspace relocation",
      description: "root A → deliberate rebind → next receipt only in root B",
    },
    {
      id: "codex-execution-workspace", name: "Codex execution workspace",
      description: "app project root + assigned workspace sandbox + sibling fixture",
    },
    {
      id: "live-execution-visibility", name: "Execution sessions: task movement",
      description: "Play · watch one task stay or advance on its real pipeline · Reset",
    },
    {
      id: "viewer-resilience", name: "Viewer resilience",
      description: "Healthy project + missing disposable pipeline + isolated diagnosis",
    },
    {
      id: "cursor-action", name: "Open workspace in Cursor",
      description: "Assigned workspace + project root + unavailable path · real action component",
    },
    {
      id: "review-server-supervisor", name: "Factorio-owned local review server",
      description: "Agent commit → safe npm argv → healthy exact-head URL → owned stop",
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
  if (id === "viewer-resilience") {
    const { runViewerResilienceScenario } =
      await import("../test/harness/ViewerResilienceScenario.ts");
    return runViewerResilienceScenario();
  }
  if (id === "cursor-action") return cursorActionScenario.snapshot();
  if (id === "review-server-supervisor") return reviewServerScenario.snapshot() as unknown as Scenario;
  throw new Error(`Unknown scenario: ${id}`);
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
.live-scenario{padding:12px;background:#fafbfa}.live-scenario-controls{display:flex;align-items:center;gap:6px;margin-bottom:10px}.live-scenario-controls button{height:32px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 12px;cursor:pointer}.live-scenario-controls .play{background:var(--ink);border-color:var(--ink);color:#fff}.live-scenario-controls button:disabled{opacity:.4;cursor:not-allowed}.live-scenario-controls span{margin-left:auto;color:var(--muted);font-size:10px;text-transform:uppercase}.activity-track{display:flex;align-items:center;gap:0;margin-top:12px;border:1px solid var(--line);background:#fff;padding:12px}.activity-node{display:flex;align-items:center;min-width:0;flex:1;color:var(--muted);font-size:10px}.activity-node:before{content:"";width:9px;height:9px;border-radius:50%;background:var(--quiet);margin-right:7px;flex:none}.activity-node.done{color:var(--ink)}.activity-node.done:before{background:var(--ink)}.activity-node.current{color:var(--ink);font-weight:750}.activity-node.current:before{background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 3px var(--neutral-soft)}.activity-node+.activity-node:after{content:"";height:1px;background:var(--line-strong);width:24px;order:-1;margin-right:8px}.activity-log{margin-top:8px;display:flex;gap:5px;flex-wrap:wrap}.activity-log span{border:1px solid var(--line);border-radius:999px;background:#fff;padding:5px 8px;color:var(--muted);font-size:9px}
.bead.current.retry{border-style:double;border-color:var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}
.resilience-projects{display:grid;gap:0;border-bottom:1px solid var(--line)}.resilience-project{min-height:44px;display:grid;grid-template-columns:minmax(180px,1fr) 150px minmax(220px,1.4fr);align-items:center;padding:7px 12px;border-bottom:1px solid var(--line);font-size:9px}.resilience-project:last-child{border-bottom:0}.resilience-project>div b{display:block;font-size:10px}.resilience-project>div span,.resilience-project small{color:var(--muted)}.resilience-project strong{justify-self:start;border:1px solid var(--line);border-radius:999px;padding:3px 8px;font-size:8px}.resilience-project.unavailable{background:#fffaf3}.resilience-project.unavailable strong{border-color:#e5c89f;background:#fff8ed;color:#986016}
.cursor-action-visual{background:#fff}.cursor-action-controls{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line)}.cursor-action-controls button{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 11px;cursor:pointer}.cursor-action-controls .play{background:var(--ink);border-color:var(--ink);color:#fff}.cursor-action-controls span{margin-left:auto;color:var(--muted);font-size:9px}.cursor-action-row{min-height:54px;display:grid;grid-template-columns:minmax(180px,.8fr) minmax(240px,1.4fr) auto;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid var(--line)}.cursor-action-row b{font-size:10px}.cursor-action-row small{display:block;color:var(--muted);font-size:8px}.cursor-action-row code{color:var(--muted);font:9px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.cursor-action-row .run-control.cursor{width:auto;min-width:106px;padding:0 9px;display:flex;gap:6px}.cursor-action-row .run-control.cursor svg{fill:none;stroke:currentColor;stroke-width:1.6}.cursor-action-result{padding:9px 12px;background:#f7f9f8;color:#52605a;font-size:9px}.cursor-action-result.failure{background:var(--danger-soft);color:var(--danger)}
.review-server-visual{background:#fff}.review-controls{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}.review-controls button{height:30px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 12px;cursor:pointer}.review-controls .play{background:var(--ink);color:#fff}.review-controls span{margin-left:auto;color:var(--muted);font-size:9px}.review-flow{display:grid;grid-template-columns:repeat(5,1fr);padding:16px 24px;border-bottom:1px solid var(--line)}.review-phase{position:relative;text-align:center;padding-top:22px;color:var(--muted);font-size:9px}.review-phase:before{content:"";position:absolute;left:0;right:0;top:8px;height:1px;background:var(--line-strong)}.review-phase:first-child:before{left:50%}.review-phase:last-child:before{right:50%}.review-phase i{position:absolute;left:50%;top:3px;width:11px;height:11px;margin-left:-5px;border:2px solid var(--quiet);border-radius:50%;background:#fff}.review-phase.done{color:var(--ink);font-weight:700}.review-phase.done i{border-color:var(--ink);background:var(--ink);box-shadow:inset 0 0 0 3px #fff}.review-facts{display:grid;grid-template-columns:1.2fr 1fr .8fr .8fr;border-bottom:1px solid var(--line)}.review-fact{padding:10px 12px;border-right:1px solid var(--line);min-width:0}.review-fact:last-child{border-right:0}.review-fact small{display:block;color:var(--muted);font-size:8px}.review-fact b,.review-fact code{display:block;overflow-wrap:anywhere;font-size:9px;line-height:1.35}.review-fact code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.review-server-visual .matrix{border-top:0}
.live-scenario{padding:0}.live-scenario-controls{margin:0;padding:12px}.live-conveyor{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff}.live-details{padding:12px}.live-details .live-panel{margin-bottom:8px}
</style></head><body><div class="app"><header class="topbar"><div class="identity"><strong>Factorio Workbench</strong><span class="online">Internal</span></div><div class="modes" role="tablist" aria-label="Workbench views"><button class="mode active" role="tab" aria-selected="true" data-source="lab">Harness Lab</button><button class="mode" role="tab" aria-selected="false" data-source="scenario">Scenario</button><button class="mode" role="tab" aria-selected="false" data-source="tests">Tests</button><button class="mode" role="tab" aria-selected="false" data-source="database">Database</button></div><div class="actions"><button class="control" id="previous" hidden>Previous</button><button class="control" id="next" hidden>Next</button><button class="control" id="refresh">Refresh</button><button class="control primary" id="run">Run scenario</button></div></header>
<main class="content"><div class="toolbar"><div class="scenario-copy"><strong id="title">Loading scenario</strong><span id="description"></span></div><select class="picker" id="scenario-picker" aria-label="Choose scenario" hidden></select><select class="picker" id="test-picker" aria-label="Choose test" hidden></select><span class="frame" id="frame"></span></div><div class="workspace" id="workspace"><div class="empty">Loading scenario…</div></div><div class="footer"><div class="legend"><span><i class="key complete"></i>Completed</span><span><i class="key imported"></i>Imported</span><span><i class="key inventory"></i>Inventory</span><span><i class="key current"></i>Current</span><span><i class="key waiting"></i>Awaiting review / needs attention</span><span><i class="key"></i>Pending</span><span><i class="key failed"></i>Failed</span></div><span class="total" id="total"></span></div><details class="inspector"><summary><span>Inspect evidence</span><small id="result"></small></summary><div class="evidence"><section class="panel"><div class="panel-head"><span id="event-label">Receipt stream</span><span>append only</span></div><div id="events"></div></section><section class="panel"><div class="panel-head"><span>Assertions</span><span id="assertion-count"></span></div><div id="checks"></div></section></div></details><div id="error" role="status"></div></main></div>
<script>
let source="lab",selected="happy",selectedTest="",scenarios=[],tests=[],testRun=null,frames=[],frame=0,timer,loadVersion=0,lab=null,selectedAttemptId="";
const byId=id=>document.getElementById(id),safe=value=>{const node=document.createElement("span");node.textContent=String(value??"");return node.innerHTML};
async function init(){[scenarios,tests]=await Promise.all([fetch("/api/scenarios").then(r=>r.json()),fetch("/api/tests").then(r=>r.json())]);selectedTest=tests[0]?.id||"";renderPickers();load()}
function renderPickers(){byId("scenario-picker").innerHTML=scenarios.map(item=>'<option value="'+safe(item.id)+'">'+safe(item.name)+'</option>').join("");byId("test-picker").innerHTML=tests.map(item=>'<option value="'+safe(item.id)+'">'+safe(item.category)+' · '+safe(item.name)+'</option>').join("")}
async function load(){clearInterval(timer);const version=++loadVersion;if(source==="tests"){testRun=null;frames=[];renderTest();return}if(source==="lab"){lab=await fetch("/api/mock-lab").then(r=>r.json());if(version===loadVersion)renderLab();return}const data=source==="database"?await fetch("/api/database").then(r=>r.json()):await fetch("/api/scenarios/"+selected).then(r=>r.json());if(version!==loadVersion)return;frames=data.frames||[data];frame=frames.length-1;renderScenario()}
function groups(steps){const result=[];for(const step of steps){const id=step.id.split(".")[0]||"pipeline",last=result.at(-1);if(last?.id===id)last.count++;else result.push({id,label:id,count:1})}return result}
function renderScenario(){const snapshot=frames[frame];if(!snapshot)return;const interactive=["live-execution","cursor-action","review-server"].includes(snapshot.visual?.kind);byId("title").textContent=snapshot.name;byId("description").textContent=snapshot.description;byId("frame").textContent=interactive?"Live temporary state":source==="scenario"?"Frame "+(frame+1)+" / "+frames.length:"Live database";byId("run").hidden=source!=="scenario"||interactive;byId("run").textContent="Run scenario";showFrameControls(source==="scenario"&&!interactive);byId("workspace").innerHTML=scenarioVisual(snapshot);renderEvidence(snapshot);byId("total").textContent=snapshot.blobs.length+" blob"+(snapshot.blobs.length===1?"":"s")+" · "+snapshot.receipts.length+" receipts";if(snapshot.visual?.kind==="live-execution")wireLiveExecution(snapshot.visual);if(snapshot.visual?.kind==="cursor-action")wireCursorAction();if(snapshot.visual?.kind==="review-server")wireReviewServer()}
function scenarioVisual(snapshot){if(snapshot.visual?.kind==="live-execution")return liveExecutionVisual(snapshot);if(snapshot.visual?.kind==="cursor-action")return cursorActionVisual(snapshot);if(snapshot.visual?.kind==="review-server")return reviewServerVisual(snapshot);if(snapshot.visual?.kind==="viewer-resilience")return viewerResilienceVisual(snapshot)+matrix(snapshot)+scenarioEvidence(snapshot);return matrix(snapshot)+scenarioEvidence(snapshot)}
function viewerResilienceVisual(snapshot){return '<section class="resilience-projects" aria-label="Viewer project health">'+snapshot.visual.projects.map(project=>'<div class="resilience-project '+(project.issue?'unavailable':'healthy')+'"><div><b>'+safe(project.name)+'</b><span>'+project.taskCount+' task'+(project.taskCount===1?'':'s')+'</span></div>'+(project.issue?'<strong title="'+safe(project.issue.detail)+'">'+safe(project.issue.summary)+'</strong><small>This project is isolated until its pipeline path is restored.</small>':'<strong>Pipeline '+safe(project.pipeline||'available')+'</strong><small>Healthy project remains usable.</small>')+'</div>').join('')+'</section>'}
function cursorActionVisual(snapshot){const data=snapshot.visual;const resultClass=data.lastResult.startsWith('Failed:')?' failure':'';return '<section class="cursor-action-visual"><div class="cursor-action-controls"><button class="play" data-cursor-scenario="play">Play assigned workspace</button><button data-cursor-scenario="reset">Reset</button><span>'+data.calls+' launch attempt'+(data.calls===1?'':'s')+'</span></div>'+data.rows.map(row=>'<div class="cursor-action-row"><div><b>'+safe(row.title)+'</b><small>'+safe(row.workspaceKind)+'</small></div><code>'+safe(row.root)+'</code>'+row.actionHtml+'</div>').join('')+'<div class="cursor-action-result'+resultClass+'">'+safe(data.lastResult)+'</div>'+scenarioEvidence(snapshot)+'</section>'}
function wireCursorAction(){document.querySelectorAll('[data-cursor-scenario]').forEach(button=>button.onclick=()=>cursorScenarioAction(button.dataset.cursorScenario));document.querySelectorAll('.cursor-action-visual [data-action="open-cursor"]').forEach(button=>button.onclick=()=>cursorScenarioOpen(button.dataset.blob))}
async function cursorScenarioAction(action){const response=await fetch('/api/cursor-action/'+action,{method:'POST'});if(!response.ok)return showScenarioError(await response.json());frames=(await response.json()).frames;frame=0;renderScenario()}
async function cursorScenarioOpen(blobId){const response=await fetch('/api/cursor-action/open/'+encodeURIComponent(blobId),{method:'POST'});if(!response.ok)return showScenarioError(await response.json());frames=(await response.json()).frames;frame=0;renderScenario()}
function showScenarioError(result){byId('error').textContent=result.error||'Scenario action failed.'}
function reviewServerVisual(snapshot){const data=snapshot.visual,order=['ready','committed','healthy','exit-received-url','stopped'],labels=['Ready','Agent committed','Server healthy','Exit received URL','Supervisor stopped'],position=order.indexOf(data.phase),server=data.server;return '<section class="review-server-visual"><div class="review-controls"><button class="play" data-review-action="play">Play</button><button data-review-action="reset">Reset</button><span>'+safe(data.phase)+'</span></div><div class="review-flow">'+labels.map((label,index)=>'<div class="review-phase '+(index<=position?'done':'')+'"><i></i>'+label+'</div>').join('')+'</div><div class="review-facts"><div class="review-fact"><small>Assigned workspace</small><code>'+safe(data.workspace)+'</code></div><div class="review-fact"><small>Exact Git head</small><code>'+safe(data.head)+'</code></div><div class="review-fact"><small>Safe argv</small><code>'+safe(server?server.command+' '+server.args.join(' '):'npm run workbench')+'</code></div><div class="review-fact"><small>Health / ownership</small><b>'+(server?safe(server.url)+' · '+(server.alive?'owned':'stopped'):'Not started')+'</b></div></div>'+matrix(snapshot)+scenarioEvidence(snapshot)+'</section>'}
function wireReviewServer(){document.querySelectorAll('[data-review-action]').forEach(button=>button.onclick=()=>reviewServerAction(button.dataset.reviewAction))}
async function reviewServerAction(action){byId('error').textContent='';const response=await fetch('/api/review-server/'+action,{method:'POST'});if(!response.ok)return showScenarioError(await response.json());frames=(await response.json()).frames;frame=0;renderScenario();if(action==='play')startReplay(renderScenario)}
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
import { ReviewServerScenario } from "../test/harness/ReviewServerScenario.ts";
import { liveExecutionStyles } from "./LiveExecutions.ts";
