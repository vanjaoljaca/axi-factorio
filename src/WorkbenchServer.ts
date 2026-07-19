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
};
type Scenario = { id: string; frames: ViewSnapshot[] };

const port = workbenchPort(process.argv);
const databasePath = resolve(argument("--db") ?? "pipelines/axi-factorio.db");
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/api/scenarios") return json(response, scenarioIndex());
    if (url.pathname === "/api/database") return json(response, databaseSnapshot());
    if (url.pathname === "/api/tests") return json(response, listVisualTests());
    if (url.pathname.startsWith("/api/tests/") && request.method === "POST") {
      return json(response, await runVisualTest(getVisualTest(url.pathname.split("/").at(-2) ?? "")));
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

function scenarioIndex(): object[] {
  return [{
    id: "happy", name: "Default happy path",
    description: "Real runner · fresh SQLite · test/harness/default",
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
.footer{display:flex;align-items:center;gap:18px;padding:12px 4px 0;color:var(--muted);font-size:9px}.legend{display:flex;align-items:center;gap:15px;flex-wrap:wrap}.legend span{display:flex;align-items:center;gap:6px}.key{position:relative;width:8px;height:8px;border-radius:50%;background:var(--quiet)}.key.complete{width:11px;height:11px;background:var(--ink)}.key.complete:after{content:"✓";position:absolute;inset:-2px 0 0;color:#fff;text-align:center;font-size:8px}.key.imported{width:10px;height:10px;border-radius:2px;background:#fff;border:1px dashed #69736d;transform:rotate(45deg)}.key.inventory{width:10px;height:10px;border-radius:2px;background:#fff;border:1px solid var(--quiet)}.key.current{width:11px;height:11px;background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.key.waiting{width:11px;height:11px;background:#fff;border:3px double var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}.key.failed{width:11px;height:11px;background:#fff;border:1px solid var(--danger)}.total{margin-left:auto}.inspector{margin-top:18px;border-top:1px solid var(--line);color:var(--muted)}.inspector summary{height:38px;display:flex;align-items:center;gap:7px;cursor:pointer;font-size:9px;text-transform:uppercase;letter-spacing:.04em}.inspector summary span{font-weight:700;color:var(--ink)}.evidence{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);border:1px solid var(--line)}.panel+.panel{border-left:1px solid var(--line)}.panel-head{height:32px;padding:0 10px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;font-size:9px;text-transform:uppercase;letter-spacing:.04em}.event{display:grid;grid-template-columns:58px 110px 90px minmax(0,1fr);gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);font-size:9px}.event span{color:var(--muted)}.check{padding:9px 10px;border-bottom:1px solid var(--line);font-size:9px}.pass{color:var(--green)}.fail{color:var(--danger)}.visual-proof{padding:24px;text-align:center;color:var(--muted)}.proof-map{display:grid;grid-template-columns:repeat(3,1fr);max-width:650px;margin:20px auto}.proof-node{position:relative;padding-top:24px;font-size:9px}.proof-node:before{content:"";position:absolute;left:0;right:0;top:8px;height:1px;background:var(--line-strong)}.proof-node:first-child:before{left:50%}.proof-node:last-child:before{right:50%}.proof-node i{position:absolute;left:50%;top:4px;transform:translateX(-50%);width:8px;height:8px;border-radius:50%;background:var(--quiet)}.proof-node.done i{width:12px;height:12px;top:2px;background:var(--ink)}.proof-node.current i{width:12px;height:12px;top:2px;background:#fff;border:2px solid var(--ink)}.pulse{animation:pulse .55s ease}@keyframes pulse{50%{background:#f7f9f8}}@media(max-width:760px){.topbar{height:auto;min-height:92px;flex-wrap:wrap;padding-block:12px}.identity{min-width:auto}.modes{order:3;margin:0;width:100%}.mode{flex:1}.content{padding-inline:12px}.matrix-head,.taskrow{grid-template-columns:145px repeat(var(--steps),minmax(66px,1fr))}.evidence{grid-template-columns:1fr}.panel+.panel{border-left:0;border-top:1px solid var(--line)}}
</style></head><body><div class="app"><header class="topbar"><div class="identity"><strong>Factorio Workbench</strong><span class="online">Internal</span></div><div class="modes" role="tablist" aria-label="Workbench views"><button class="mode active" role="tab" aria-selected="true" data-source="scenario">Scenario</button><button class="mode" role="tab" aria-selected="false" data-source="tests">Tests</button><button class="mode" role="tab" aria-selected="false" data-source="database">Database</button></div><div class="actions"><button class="control" id="previous" hidden>Previous</button><button class="control" id="next" hidden>Next</button><button class="control" id="refresh">Refresh</button><button class="control primary" id="run">Run scenario</button></div></header>
<main class="content"><div class="toolbar"><div class="scenario-copy"><strong id="title">Loading scenario</strong><span id="description"></span></div><select class="picker" id="scenario-picker" aria-label="Choose scenario"></select><select class="picker" id="test-picker" aria-label="Choose test" hidden></select><span class="frame" id="frame"></span></div><div class="workspace" id="workspace"><div class="empty">Loading scenario…</div></div><div class="footer"><div class="legend"><span><i class="key complete"></i>Completed</span><span><i class="key imported"></i>Imported</span><span><i class="key inventory"></i>Inventory</span><span><i class="key current"></i>Current</span><span><i class="key waiting"></i>Awaiting review / needs attention</span><span><i class="key"></i>Pending</span><span><i class="key failed"></i>Failed</span></div><span class="total" id="total"></span></div><details class="inspector"><summary><span>Inspect evidence</span><small id="result"></small></summary><div class="evidence"><section class="panel"><div class="panel-head"><span id="event-label">Receipt stream</span><span>append only</span></div><div id="events"></div></section><section class="panel"><div class="panel-head"><span>Assertions</span><span id="assertion-count"></span></div><div id="checks"></div></section></div></details><div id="error" role="status"></div></main></div>
<script>
let source="scenario",selected="happy",selectedTest="",scenarios=[],tests=[],testRun=null,frames=[],frame=0,timer,loadVersion=0;
const byId=id=>document.getElementById(id),safe=value=>{const node=document.createElement("span");node.textContent=String(value??"");return node.innerHTML};
async function init(){[scenarios,tests]=await Promise.all([fetch("/api/scenarios").then(r=>r.json()),fetch("/api/tests").then(r=>r.json())]);selectedTest=tests[0]?.id||"";renderPickers();load()}
function renderPickers(){byId("scenario-picker").innerHTML=scenarios.map(item=>'<option value="'+safe(item.id)+'">'+safe(item.name)+'</option>').join("");byId("test-picker").innerHTML=tests.map(item=>'<option value="'+safe(item.id)+'">'+safe(item.category)+' · '+safe(item.name)+'</option>').join("")}
async function load(){clearInterval(timer);const version=++loadVersion;if(source==="tests"){testRun=null;frames=[];renderTest();return}const data=source==="database"?await fetch("/api/database").then(r=>r.json()):await fetch("/api/scenarios/"+selected).then(r=>r.json());if(version!==loadVersion)return;frames=data.frames||[data];frame=frames.length-1;renderScenario()}
function groups(steps){const result=[];for(const step of steps){const id=step.id.split(".")[0]||"pipeline",last=result.at(-1);if(last?.id===id)last.count++;else result.push({id,label:id,count:1})}return result}
function renderScenario(){const snapshot=frames[frame];if(!snapshot)return;byId("title").textContent=snapshot.name;byId("description").textContent=snapshot.description;byId("frame").textContent=source==="scenario"?"Frame "+(frame+1)+" / "+frames.length:"Live database";byId("run").hidden=source!=="scenario";byId("run").textContent="Run scenario";showFrameControls(source==="scenario");byId("workspace").innerHTML=matrix(snapshot);renderEvidence(snapshot);byId("total").textContent=snapshot.blobs.length+" blob"+(snapshot.blobs.length===1?"":"s")+" · "+snapshot.receipts.length+" receipts"}
function matrix(snapshot){const steps=snapshot.steps,bands=groups(steps),rows=snapshot.blobs.length?snapshot.blobs.map(blob=>taskRow(blob,steps)).join(""):'<div class="empty">No blobs in this database.</div>';return '<div class="matrix" style="--steps:'+Math.max(steps.length,1)+'"><div class="matrix-head" style="--steps:'+Math.max(steps.length,1)+'"><div class="corner"></div>'+bands.map(group=>'<div class="band" style="grid-column:span '+group.count+'">'+safe(group.label)+'</div>').join("")+steps.map(step=>'<div class="step">'+safe(step.label)+'</div>').join("")+'</div><section class="project"><div class="project-head"><span>'+safe(source==="database"?"Database state":"Scenario state")+'</span><span class="count">'+snapshot.blobs.length+'</span></div><div class="taskrows">'+rows+'</div></section></div>'}
function taskRow(blob,steps){const current=steps.findIndex(step=>step.id===blob.stepId),complete=blob.stepId==="complete"||blob.state==="complete",cells=steps.map((step,index)=>{const done=complete||index<current,isCurrent=!complete&&index===current,classes=["bead",done?"done":"",isCurrent?"current":"",isCurrent?blob.state:""].filter(Boolean).join(" ");return '<div class="track-cell '+(index===0?"first ":"")+(index===steps.length-1?"last":"")+'"><i class="'+classes+'"></i></div>'}).join("");const label=statusLabel(blob.state);return '<div class="taskrow" style="--steps:'+Math.max(steps.length,1)+'"><div class="task-title" title="'+safe(blob.id)+'"><span class="task-name">'+safe(blob.title)+'</span>'+(label?'<small class="task-status '+safe(blob.state)+'">'+safe(label)+'</small>':"")+'</div>'+cells+'</div>'}
function statusLabel(status){return {running:"Running",waiting:"Awaiting review",blocked:"Needs attention",failed:"Failed",held:"Inventory"}[status]||""}
function renderEvidence(snapshot){byId("event-label").textContent="Receipt stream";byId("events").innerHTML=snapshot.receipts.length?snapshot.receipts.slice().reverse().map(receipt=>'<div class="event"><span>'+safe(receipt.at)+'</span><b>'+safe(receipt.stepId)+'</b><b class="'+(receipt.status==="failed"?"fail":"")+'">'+safe(receipt.status)+'</b><span>'+safe(receipt.detail)+'</span></div>').join(""):'<div class="empty">No receipts yet.</div>';byId("checks").innerHTML=snapshot.assertions.length?snapshot.assertions.map(assertion=>'<div class="check"><b class="'+(assertion.passed?"pass":"fail")+'">'+(assertion.passed?"✓":"×")+'</b> '+safe(assertion.label)+'</div>').join(""):'<div class="empty">Read-only database view.</div>';const passed=snapshot.assertions.filter(item=>item.passed).length;byId("assertion-count").textContent=snapshot.assertions.length?passed+" / "+snapshot.assertions.length:"";byId("result").textContent=snapshot.assertions.length&&passed===snapshot.assertions.length?"All assertions pass":""}
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

import { createServer, type ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import { FactorioDatabase } from "./Database.ts";
import { ConveyorStore } from "./Store.ts";
import type { Blob, Receipt } from "./Types.ts";
import { discoverPipeline } from "./Pipeline.ts";
import type { TestHarness } from "../test/harness/CreateTestHarness.ts";
import { getVisualTest, listVisualTests, runVisualTest } from "../test/visual/TestCatalog.ts";
import { workbenchPort } from "./WorkbenchPort.ts";
