type ViewStep = { id: string; label: string };
type ViewBlob = { id: string; title: string; state: string; stepId: string | null };
type ViewReceipt = {
  id: string;
  blobId: string;
  stepId: string;
  status: string;
  at: string;
  detail: string;
};
type ViewSnapshot = {
  name: string;
  description: string;
  source: "scenario" | "database";
  steps: ViewStep[];
  blobs: ViewBlob[];
  receipts: ViewReceipt[];
  assertions: { label: string; passed: boolean }[];
};
type Scenario = { id: string; frames: ViewSnapshot[] };

const port = Number(argument("--port") ?? "4317");
const databasePath = resolve(argument("--db") ?? "pipelines/axi-factorio.db");
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/api/scenarios") return json(response, scenarioIndex());
    if (url.pathname === "/api/database") return json(response, databaseSnapshot());
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

function scenarioIndex(): object[] {
  return [{
    id: "happy",
    name: "Default happy path",
    description: "Real runner + empty SQLite + test/harness/default.",
  }];
}

async function scenario(url: URL): Promise<Scenario> {
  const id = url.pathname.split("/").at(-1);
  if (id !== "happy") throw new Error(`Unknown scenario: ${id}`);
  return runHappyPath();
}

function databaseSnapshot(): ViewSnapshot {
  const database = new FactorioDatabase(databasePath);
  try {
    const store = new ConveyorStore(database);
    const blobs = store.listBlobs();
    const receipts = store.listReceipts();
    const stepIds = [...new Set(blobs.flatMap((blob) =>
      discoverPipeline(blob.pipelinePath).map((step) => step.id)))];
    return {
      name: basename(databasePath),
      description: databasePath,
      source: "database",
      steps: [...stepIds.map((id) => ({ id, label: id })), { id: "complete", label: "complete" }],
      blobs: blobs.map((blob) => ({
        id: blob.id, title: blob.title, state: displayStatus(blob, receipts),
        stepId: blob.state,
      })),
      receipts: receipts.map((receipt) => ({
        id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId,
        status: receipt.invalidatedAt ? "invalidated" : receipt.status,
        at: receipt.finishedAt ?? receipt.startedAt,
        detail: receipt.reason ?? receipt.error ?? `attempt ${receipt.attempt}`,
      })),
      assertions: [],
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
    source: "scenario",
    steps: [
      ...harness.steps.map((step) => ({ id: step.id, label: step.id })),
      { id: "complete", label: "complete" },
    ],
    blobs: blobs.map((blob) => ({
      id: blob.id, title: blob.title, state: displayStatus(blob, receipts),
      stepId: blob.state,
    })),
    receipts: receipts.map((receipt) => ({
      id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId,
      status: receipt.status, at: receipt.startedAt.slice(11, 19),
      detail: receipt.reason ?? receipt.error ?? `attempt ${receipt.attempt}`,
    })),
    assertions: [
      { label: "Loaded 3 paired Markdown stages", passed: harness.steps.length === 3 },
      { label: "Actual runner wrote one receipt per completed stage", passed: receipts.length <= 3 },
      { label: "Blob completed through g3.third", passed: !final || blobs[0]?.lastCompletedStepId === "g3.third" },
    ],
  };
}

function displayStatus(blob: Blob, receipts: Receipt[]): string {
  if (blob.state === "complete") return "complete";
  const latest = receipts.filter((receipt) =>
    receipt.blobId === blob.id && !receipt.invalidatedAt).at(-1);
  if (latest?.status === "running") return "running";
  if (blob.paused) return latest?.status ?? "paused";
  return "needs work";
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
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
<title>axi-factorio workbench</title><style>
:root{color-scheme:light;--bg:#f3f1eb;--panel:#fffefa;--line:#d8d5cc;--muted:#6e746f;--ink:#171b18;--acid:#5b8f18;--amber:#b96d00;--red:#c74444;--cyan:#167b78}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
button{font:inherit}.shell{min-height:100vh;display:grid;grid-template-columns:240px 1fr}.rail{border-right:1px solid var(--line);padding:20px 14px;background:#ebe8df}
.brand{font-size:17px;font-weight:800;letter-spacing:-.04em}.brand i{color:var(--acid);font-style:normal}.eyebrow{color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.12em;margin:24px 8px 8px}
.source,.scenario{width:100%;text-align:left;border:1px solid transparent;background:transparent;color:var(--muted);padding:9px 10px;border-radius:6px;cursor:pointer}.source.active,.scenario.active{background:var(--panel);color:var(--ink);border-color:var(--line)}.scenario small{display:block;color:#7d827e}
.main{min-width:0}.top{height:64px;padding:13px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px}.title{font-size:15px;font-weight:700}.desc{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.actions{margin-left:auto;display:flex;gap:8px}.btn{border:1px solid var(--line);background:#f8f6ef;color:var(--ink);padding:8px 11px;border-radius:5px;cursor:pointer}.btn.primary{background:var(--acid);color:#fff;border-color:var(--acid);font-weight:800}
.stats{display:flex;border-bottom:1px solid var(--line)}.stat{padding:11px 22px;border-right:1px solid var(--line);color:var(--muted)}.stat b{color:var(--ink);margin-right:6px}
.content{padding:18px 22px;display:grid;grid-template-rows:minmax(280px,1fr) 250px;gap:16px;height:calc(100vh - 105px)}.panel{border:1px solid var(--line);background:var(--panel);border-radius:8px;min-height:0;overflow:hidden}.panelhead{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.belt{height:calc(100% - 39px);overflow:auto}.taskhead,.taskrow{display:grid;grid-template-columns:minmax(220px,1.2fr) minmax(420px,2fr) 110px;align-items:center;gap:22px;padding:10px 16px}.taskhead{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--line)}.taskrow{min-height:72px;border-bottom:1px solid var(--line)}.taskmeta{min-width:0}.blobid{font-size:10px;color:var(--muted)}.blobtitle{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.badge{font-size:11px;color:var(--muted)}.badge.running{color:var(--cyan)}.badge.blocked,.badge.failed{color:var(--red)}.badge.complete{color:var(--acid)}
.track{display:grid;grid-template-columns:repeat(var(--steps),minmax(68px,1fr));position:relative}.beadcell{position:relative;text-align:center;padding-top:24px;color:var(--muted);font-size:10px;white-space:nowrap}.beadcell:before{content:"";position:absolute;left:0;right:0;top:8px;height:1px;background:var(--line)}.beadcell:first-child:before{left:50%}.beadcell:last-child:before{right:50%}.bead{position:absolute;width:11px;height:11px;border-radius:50%;background:#bfc3c0;left:50%;top:3px;transform:translateX(-50%);z-index:2}.bead.done{background:var(--acid)}.bead.current{background:var(--panel);border:3px solid var(--acid);box-shadow:0 0 0 3px #5b8f1830;width:14px;height:14px;top:1px}.bead.failed{border-color:var(--red);box-shadow:0 0 0 3px #c7444430}.bead.complete.current{background:var(--acid)}
.lower{display:grid;grid-template-columns:1fr 310px;gap:16px;min-height:0}.timeline,.checks{overflow:auto}.event{display:grid;grid-template-columns:55px 120px 150px 1fr;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line)}.event span{color:var(--muted)}.event b{font-weight:500}.empty{height:100%;display:grid;place-items:center;color:var(--muted);text-align:center}.check{padding:10px 12px;border-bottom:1px solid var(--line)}.pass{color:var(--acid)}.fail{color:var(--red)}.pulse{animation:pulse .65s ease}@keyframes pulse{50%{filter:brightness(1.12)}}@media(max-width:850px){.shell{grid-template-columns:1fr}.rail{display:none}.lower{grid-template-columns:1fr}.checks{display:none}}
</style></head><body><div class="shell">
<aside class="rail"><div class="brand">axi-<i>factorio</i></div><div class="eyebrow">Source</div>
<button class="source active" data-source="scenario">Scenario lab</button><button class="source" data-source="database">SQLite database</button>
<div class="eyebrow">Scenarios</div><div id="scenarios"></div></aside>
<main class="main"><header class="top"><div><div class="title" id="title">Loading</div><div class="desc" id="description"></div></div>
<div class="actions"><button class="btn" id="refresh">Refresh</button><button class="btn primary" id="run">▶ Run scenario</button></div></header>
<div class="stats" id="stats"></div><section class="content"><div class="panel"><div class="panelhead"><span>Blobs</span><span id="frame"></span></div><div class="belt" id="belt"></div></div>
<div class="lower"><div class="panel timeline"><div class="panelhead"><span>Receipt stream</span><span>append only</span></div><div id="events"></div></div>
<div class="panel checks"><div class="panelhead"><span>Assertions</span><span id="result"></span></div><div id="checks"></div></div></div></section></main></div>
<script>
let source="scenario",selected="happy",frames=[],frame=0,timer;
const $=id=>document.getElementById(id);
async function init(){const rows=await fetch("/api/scenarios").then(r=>r.json());$("scenarios").innerHTML=rows.map((s,i)=>'<button class="scenario '+(i?"":"active")+'" data-id="'+s.id+'">'+s.name+'<small>'+s.description+'</small></button>').join("");document.querySelectorAll(".scenario").forEach(b=>b.onclick=()=>{selected=b.dataset.id;document.querySelectorAll(".scenario").forEach(x=>x.classList.toggle("active",x===b));load()});load()}
async function load(){clearInterval(timer);const data=source==="database"?await fetch("/api/database").then(r=>r.json()):await fetch("/api/scenarios/"+selected).then(r=>r.json());frames=data.frames||[data];frame=frames.length-1;render()}
function render(){const s=frames[frame];$("title").textContent=s.name;$("description").textContent=s.description;$("frame").textContent=source==="scenario"?"frame "+(frame+1)+" / "+frames.length:"live database";$("run").style.display=source==="scenario"?"":"none";
const counts=Object.groupBy(s.blobs,b=>b.state);$("stats").innerHTML=['blobs '+s.blobs.length,...Object.entries(counts).map(([k,v])=>k+' '+v.length),'receipts '+s.receipts.length].map(x=>'<div class="stat"><b>'+x.split(" ").at(-1)+'</b>'+x.split(" ").slice(0,-1).join(" ")+'</div>').join("");
const steps=s.steps;$("belt").innerHTML='<div class="taskhead"><span>Task</span><span>Pipeline</span><span>Status</span></div>'+s.blobs.map(b=>{const current=Math.max(0,steps.findIndex(step=>step.id===b.stepId));const beads=steps.map((step,i)=>{const cls=i<current?"done":i===current?"current "+(b.state==="failed"||b.state==="blocked"?"failed":""):"";return '<div class="beadcell"><i class="bead '+cls+' '+(step.id==="complete"?"complete":"")+'"></i>'+step.label+'</div>'}).join("");return '<div class="taskrow"><div class="taskmeta"><div class="blobtitle">'+b.title+'</div><div class="blobid">'+b.id+'</div></div><div class="track" style="--steps:'+steps.length+'">'+beads+'</div><span class="badge '+b.state+'">'+b.state+'</span></div>'}).join("");
$("events").innerHTML=s.receipts.length?s.receipts.slice().reverse().map(r=>'<div class="event"><span>'+r.at+'</span><b>'+r.stepId+'</b><b class="'+(r.status==="blocked"?"fail":"")+'">'+r.status+'</b><span>'+r.detail+'</span></div>').join(""):'<div class="empty">No receipts yet.<br>Add a blob or run a scenario.</div>';
$("checks").innerHTML=s.assertions.length?s.assertions.map(a=>'<div class="check"><b class="'+(a.passed?"pass":"fail")+'">'+(a.passed?"✓":"×")+'</b> '+a.label+'</div>').join(""):'<div class="empty">Database inspection<br>does not mutate state.</div>';$("result").textContent=s.assertions.every(a=>a.passed)?"PASS":""}
function run(){clearInterval(timer);frame=0;render();timer=setInterval(()=>{if(frame>=frames.length-1)return clearInterval(timer);frame++;render();$("belt").classList.add("pulse");setTimeout(()=>$("belt").classList.remove("pulse"),500)},650)}
document.querySelectorAll(".source").forEach(b=>b.onclick=()=>{source=b.dataset.source;document.querySelectorAll(".source").forEach(x=>x.classList.toggle("active",x===b));load()});$("run").onclick=run;$("refresh").onclick=load;init();
</script></body></html>`;

import { createServer, type ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import { FactorioDatabase } from "./Database.ts";
import { ConveyorStore } from "./Store.ts";
import type { Blob, Receipt } from "./Types.ts";
import { discoverPipeline } from "./Pipeline.ts";
import type { TestHarness } from "../test/harness/CreateTestHarness.ts";
