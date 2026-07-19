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
    if (url.pathname === "/api/tests") return json(response, listVisualTests());
    if (url.pathname.startsWith("/api/tests/") && request.method === "POST") {
      const test = getVisualTest(url.pathname.split("/").at(-2) ?? "");
      return json(response, await runVisualTest(test));
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
:root{color-scheme:light;--bg:#f3f1eb;--panel:#fffefa;--line:#d8d5cc;--muted:#5f665f;--ink:#171b18;--acid:#5b8f18;--amber:#b96d00;--red:#c74444;--cyan:#167b78}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
button,input{font:inherit}.shell{min-height:100vh;display:grid;grid-template-columns:270px 1fr}.rail{border-right:1px solid var(--line);padding:20px 14px;background:#ebe8df;height:100vh;overflow:hidden;display:flex;flex-direction:column}.rail>[role=tablist]{flex:none}
.brand{font-size:17px;font-weight:800;letter-spacing:-.04em}.brand i{color:var(--acid);font-style:normal}.eyebrow{color:var(--muted);text-transform:uppercase;font-size:10px;letter-spacing:.12em;margin:24px 8px 8px}
.source,.scenario{width:100%;text-align:left;border:1px solid transparent;background:transparent;color:var(--muted);padding:9px 10px;border-radius:6px;cursor:pointer}.source.active,.scenario.active{background:var(--panel);color:var(--ink);border-color:var(--line)}.scenario small{display:block;color:#7d827e}
.test-nav,.scenario-nav{flex:1;min-height:0;display:flex;flex-direction:column}.test-nav[hidden],.scenario-nav[hidden]{display:none}.test-search{width:100%;flex:none;border:1px solid var(--line);background:var(--panel);border-radius:5px;padding:8px;margin:0 0 8px;color:var(--ink)}.test-list,.scenario-list{min-height:0;overflow:auto}.test-category{margin:14px 8px 5px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.1em}.testcase{width:100%;border:1px solid transparent;background:transparent;text-align:left;padding:8px 9px;border-radius:5px;color:var(--ink);cursor:pointer}.testcase:hover{background:#f4f2eb}.testcase.active{background:var(--panel);border-color:var(--line)}.testcase small{display:block;color:var(--muted);margin-top:2px;font-size:11px}
.main{min-width:0}.top{height:64px;padding:13px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;min-width:0}.top>div:first-child{min-width:0;flex:1}.title{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.desc{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.actions{margin-left:auto;display:flex;gap:8px}.btn{border:1px solid var(--line);background:#f8f6ef;color:var(--ink);padding:8px 11px;border-radius:5px;cursor:pointer}.btn.primary{background:var(--acid);color:#fff;border-color:var(--acid);font-weight:800}.btn:disabled{opacity:.5;cursor:wait}
.stats{display:flex;border-bottom:1px solid var(--line);min-width:0;overflow:hidden}.stat{padding:11px 22px;border-right:1px solid var(--line);color:var(--muted);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.stat b{color:var(--ink);margin-right:6px}
.content{padding:18px 22px;display:grid;grid-template-rows:minmax(280px,1fr) 250px;gap:16px;height:calc(100vh - 105px);min-width:0}.panel{border:1px solid var(--line);background:var(--panel);border-radius:8px;min-width:0;min-height:0;overflow:hidden}.panelhead{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.belt{height:calc(100% - 39px);overflow:auto}.taskhead,.taskrow{display:grid;grid-template-columns:minmax(220px,1.2fr) minmax(420px,2fr) 110px;align-items:center;gap:22px;padding:10px 16px}.taskhead{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--line)}.taskrow{min-height:72px;border-bottom:1px solid var(--line)}.taskmeta{min-width:0}.blobid{font-size:10px;color:var(--muted)}.blobtitle{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.badge{font-size:11px;color:var(--muted)}.badge.running{color:var(--cyan)}.badge.blocked,.badge.failed{color:var(--red)}.badge.complete{color:var(--acid)}
.track{display:grid;grid-template-columns:repeat(var(--steps),minmax(68px,1fr));position:relative}.beadcell{position:relative;text-align:center;padding-top:24px;color:var(--muted);font-size:10px;white-space:nowrap}.beadcell:before{content:"";position:absolute;left:0;right:0;top:8px;height:1px;background:var(--line)}.beadcell:first-child:before{left:50%}.beadcell:last-child:before{right:50%}.bead{position:absolute;width:11px;height:11px;border-radius:50%;background:#bfc3c0;left:50%;top:3px;transform:translateX(-50%);z-index:2}.bead.done{background:var(--acid)}.bead.current{background:var(--panel);border:3px solid var(--acid);box-shadow:0 0 0 3px #5b8f1830;width:14px;height:14px;top:1px}.bead.failed{border-color:var(--red);box-shadow:0 0 0 3px #c7444430}.bead.complete.current{background:var(--acid)}
.lower{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:16px;min-height:0;min-width:0}.timeline,.checks{min-width:0;overflow:auto}.event{display:grid;grid-template-columns:55px 120px 150px minmax(0,1fr);gap:10px;padding:8px 12px;border-bottom:1px solid var(--line)}.event span{color:var(--muted)}.event b{font-weight:500}.empty{height:100%;display:grid;place-items:center;color:var(--muted);text-align:center}.check{padding:10px 12px;border-bottom:1px solid var(--line)}.pass{color:var(--acid)}.fail{color:var(--red)}.pulse{animation:pulse .65s ease}@keyframes pulse{50%{filter:brightness(1.12)}}@media(max-width:850px){.shell{grid-template-columns:1fr}.rail{display:none}.lower{grid-template-columns:1fr}.checks{display:none}}
.visual-proof{height:100%;padding:16px 20px;overflow:auto}.proof-meta{display:flex;gap:7px;margin:8px 0 14px}.proof-pill{border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted)}.proof-map{display:grid;grid-template-columns:repeat(3,1fr);align-items:center;margin:28px auto 20px;max-width:680px}.proof-node{position:relative;text-align:center;padding-top:26px;color:var(--muted);font-size:10px}.proof-node:before{content:"";position:absolute;top:8px;left:0;right:0;height:1px;background:var(--line)}.proof-node:first-child:before{left:50%}.proof-node:last-child:before{right:50%}.proof-node i{position:absolute;left:50%;top:2px;transform:translateX(-50%);width:12px;height:12px;border-radius:50%;background:#bfc3c0;z-index:1}.proof-node.done i{background:var(--acid)}.proof-node.current i{width:15px;height:15px;top:0;background:var(--panel);border:3px solid var(--acid);box-shadow:0 0 0 3px #5b8f1830}.proof-note{max-width:680px;margin:auto;border:1px solid var(--line);border-radius:7px;padding:12px;color:var(--muted)}.transcript{padding:10px 12px;border-bottom:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}.test-event{display:grid;grid-template-columns:150px 90px minmax(0,1fr);gap:10px;padding:9px 12px;border-bottom:1px solid var(--line)}.test-event span{color:var(--muted);overflow-wrap:anywhere}
</style></head><body><div class="shell">
<aside class="rail"><div class="brand">axi-<i>factorio</i></div><div class="eyebrow">Workbench</div>
<div role="tablist" aria-label="Workbench views"><button class="source active" role="tab" aria-selected="true" tabindex="0" data-source="scenario">Scenario lab</button><button class="source" role="tab" aria-selected="false" tabindex="-1" data-source="database">SQLite database</button><button class="source" role="tab" aria-selected="false" tabindex="-1" data-source="tests">Tests</button></div>
<div class="scenario-nav" id="scenario-nav"><div class="eyebrow">Scenarios</div><div class="scenario-list" id="scenarios"></div></div>
<div class="test-nav" id="test-nav" hidden><div class="eyebrow" id="test-heading">Test catalog</div><input class="test-search" id="test-search" type="search" aria-label="Filter tests" placeholder="Filter tests"><div class="test-list" id="tests"></div></div></aside>
<main class="main"><header class="top"><div><div class="title" id="title">Loading</div><div class="desc" id="description"></div></div>
<div class="actions"><button class="btn" id="previous" hidden>Previous</button><button class="btn" id="next" hidden>Next</button><button class="btn" id="refresh">Refresh</button><button class="btn primary" id="run">Run scenario</button></div></header>
<div class="stats" id="stats"></div><section class="content"><div class="panel"><div class="panelhead"><span id="upper-label">Blobs</span><span id="frame"></span></div><div class="belt" id="belt"></div></div>
<div class="lower"><div class="panel timeline"><div class="panelhead"><span id="lower-label">Receipt stream</span><span id="lower-detail">append only</span></div><div id="events"></div></div>
<div class="panel checks"><div class="panelhead"><span>Assertions</span><span id="result"></span></div><div id="checks"></div></div></div></section></main></div>
<script>
let source="scenario",selected="happy",selectedTest="",scenarios=[],tests=[],testRun=null,frames=[],frame=0,timer,loadVersion=0;
const $=id=>document.getElementById(id);
async function init(){[scenarios,tests]=await Promise.all([fetch("/api/scenarios").then(r=>r.json()),fetch("/api/tests").then(r=>r.json())]);selectedTest=tests[0]?.id||"";renderScenarioNav();renderTestNav();load()}
function renderScenarioNav(){$("scenarios").innerHTML=scenarios.map((s,i)=>'<button class="scenario '+(i?"":"active")+'" data-id="'+safe(s.id)+'">'+safe(s.name)+'<small>'+safe(s.description)+'</small></button>').join("");document.querySelectorAll(".scenario").forEach(b=>b.onclick=()=>{selected=b.dataset.id;document.querySelectorAll(".scenario").forEach(x=>x.classList.toggle("active",x===b));load()})}
function renderTestNav(){const query=$("test-search").value.trim().toLowerCase();const shown=tests.filter(test=>!query||test.name.toLowerCase().includes(query)||test.category.toLowerCase().includes(query));$("test-heading").textContent="Test catalog · "+tests.length;const groups=Object.groupBy(shown,test=>test.category);$("tests").innerHTML=Object.entries(groups).map(([category,items])=>'<div class="test-category">'+safe(category)+' · '+items.length+'</div>'+items.map(test=>'<button class="testcase '+(test.id===selectedTest?"active":"")+'" data-test-id="'+safe(test.id)+'">'+safe(test.name)+'<small>'+safe(test.visualLabel)+'</small></button>').join("")).join("")||'<div class="empty">No matching tests.</div>';document.querySelectorAll(".testcase").forEach(button=>button.onclick=()=>{selectedTest=button.dataset.testId;testRun=null;renderTestNav();renderTest()})}
async function load(){clearInterval(timer);const version=++loadVersion;const testMode=source==="tests";$("scenario-nav").hidden=testMode;$("test-nav").hidden=!testMode;if(testMode){testRun=null;frames=[];renderTest();return}const data=source==="database"?await fetch("/api/database").then(r=>r.json()):await fetch("/api/scenarios/"+selected).then(r=>r.json());if(version!==loadVersion)return;frames=data.frames||[data];frame=frames.length-1;renderScenario()}
function renderScenario(){const s=frames[frame];$("upper-label").textContent="Blobs";$("lower-label").textContent="Receipt stream";$("lower-detail").textContent="append only";$("title").textContent=s.name;$("description").textContent=s.description;$("frame").textContent=source==="scenario"?"frame "+(frame+1)+" / "+frames.length:"live database";$("run").style.display=source==="scenario"?"":"none";$("run").textContent="Run scenario";showFrameControls(source==="scenario");
const counts=Object.groupBy(s.blobs,b=>b.state);$("stats").innerHTML=['blobs '+s.blobs.length,...Object.entries(counts).map(([k,v])=>k+' '+v.length),'receipts '+s.receipts.length].map(x=>'<div class="stat"><b>'+x.split(" ").at(-1)+'</b>'+x.split(" ").slice(0,-1).join(" ")+'</div>').join("");
const steps=s.steps;$("belt").innerHTML='<div class="taskhead"><span>Task</span><span>Pipeline</span><span>Status</span></div>'+s.blobs.map(b=>{const current=Math.max(0,steps.findIndex(step=>step.id===b.stepId));const beads=steps.map((step,i)=>{const cls=i<current?"done":i===current?"current "+(b.state==="failed"||b.state==="blocked"?"failed":""):"";return '<div class="beadcell"><i class="bead '+cls+' '+(step.id==="complete"?"complete":"")+'"></i>'+step.label+'</div>'}).join("");return '<div class="taskrow"><div class="taskmeta"><div class="blobtitle">'+b.title+'</div><div class="blobid">'+b.id+'</div></div><div class="track" style="--steps:'+steps.length+'">'+beads+'</div><span class="badge '+b.state+'">'+b.state+'</span></div>'}).join("");
$("events").innerHTML=s.receipts.length?s.receipts.slice().reverse().map(r=>'<div class="event"><span>'+r.at+'</span><b>'+r.stepId+'</b><b class="'+(r.status==="blocked"?"fail":"")+'">'+r.status+'</b><span>'+r.detail+'</span></div>').join(""):'<div class="empty">No receipts yet.<br>Add a blob or run a scenario.</div>';
$("checks").innerHTML=s.assertions.length?s.assertions.map(a=>'<div class="check"><b class="'+(a.passed?"pass":"fail")+'">'+(a.passed?"✓":"×")+'</b> '+a.label+'</div>').join(""):'<div class="empty">Database inspection<br>does not mutate state.</div>';$("result").textContent=s.assertions.every(a=>a.passed)?"PASS":""}
function renderTest(){const test=tests.find(item=>item.id===selectedTest);if(!test)return;$("upper-label").textContent="Visual proof";$("lower-label").textContent="Evidence";$("lower-detail").textContent="actual test output";$("title").textContent=test.name;$("description").textContent=test.visualDescription;$("run").style.display="";$("run").textContent=testRun?"Replay actual test":"Run actual test";const current=testRun?.frames[frame];$("frame").textContent=current?"frame "+(frame+1)+" / "+testRun.frames.length:test.visualLabel;showFrameControls(Boolean(testRun));$("stats").innerHTML=[test.category,test.visualLabel,test.file].map((value,index)=>'<div class="stat">'+(index===0?"category ":index===1?"visual ":"source ")+'<b>'+safe(value)+'</b></div>').join("");$("belt").innerHTML=renderProof(test,current);$("events").innerHTML=renderTestEvents(current);$("checks").innerHTML=renderTestChecks(current);$("result").textContent=current?.status==="passed"?"PASS":current?.status==="failed"?"FAIL":""}
function renderProof(test,current){const labels=proofLabels(test.visualKind);const point=current?.status==="passed"?2:current?.events.length?1:0;const passed=current?.status==="passed";return '<div class="visual-proof"><div class="proof-meta"><span class="proof-pill">'+safe(test.category)+'</span><span class="proof-pill">'+safe(test.visualLabel)+'</span></div><div class="proof-map">'+labels.map((label,index)=>'<div class="proof-node '+(passed&&index<=point?"done":index<point?"done":index===point?"current":"")+'"><i></i>'+safe(label)+'</div>').join("")+'</div><div class="proof-note"><b>'+safe(current?.label||"Visual contract")+'</b><br>'+safe(test.visualDescription)+(current?'<br><br>Actual test status: '+safe(current.status):'<br><br>Select Run actual test to execute the real Node test and replay its observable evidence.')+'</div></div>'}
function renderTestEvents(current){if(!current)return '<div class="empty">No execution yet.<br>The visual contract is ready.</div>';if(current.events.length)return current.events.slice().reverse().map(event=>'<div class="test-event"><b>'+safe(event.event)+'</b><span>'+safe(event.status)+'</span><span>'+safe(event.detail)+'</span></div>').join("");return current.transcript.map(line=>'<div class="transcript">'+safe(line)+'</div>').join("")}
function renderTestChecks(current){if(!current)return '<div class="empty">Runs the actual test file<br>with an exact name filter.</div>';const finished=current.status!=="running";return '<div class="check"><b class="'+(current.status==="failed"?"fail":"pass")+'">'+(finished?(current.status==="passed"?"✓":"×"):"·")+'</b> '+safe(current.label)+'</div>'+(finished?'<div class="check">'+testRun.durationMs+' ms · exit '+testRun.exitCode+'</div>':'')}
function proofLabels(kind){return {["terminal-proof"]:["test invoked","TAP assertion","exit proof"],["service-timeline"]:["lease acquired","service events","disposition"],["conveyor-replay"]:["blob created","receipt events","final state"]}[kind]}
async function run(){if(source!=="tests"){startReplay(renderScenario);return}if(testRun){startReplay(renderTest);return}$("run").disabled=true;$("run").textContent="Running actual test";try{const response=await fetch("/api/tests/"+encodeURIComponent(selectedTest)+"/run",{method:"POST"});if(!response.ok)throw new Error(await response.text());testRun=await response.json();frames=testRun.frames;frame=0;renderTest();startReplay(renderTest)}catch(error){$("events").innerHTML='<div class="empty fail">'+safe(error.message)+'</div>';$("run").textContent="Run actual test"}finally{$("run").disabled=false}}
function startReplay(renderer){clearInterval(timer);frame=0;renderer();timer=setInterval(()=>{if(frame>=frames.length-1)return clearInterval(timer);frame++;renderer();$("belt").classList.add("pulse");setTimeout(()=>$("belt").classList.remove("pulse"),500)},650)}
function showFrameControls(show){$("previous").hidden=!show;$("next").hidden=!show;$("previous").disabled=frame<=0;$("next").disabled=frame>=frames.length-1}
function moveFrame(delta){clearInterval(timer);frame=Math.max(0,Math.min(frames.length-1,frame+delta));source==="tests"?renderTest():renderScenario()}
function safe(value){const node=document.createElement("span");node.textContent=String(value??"");return node.innerHTML}
function selectSource(button){source=button.dataset.source;document.querySelectorAll(".source").forEach(item=>{const selected=item===button;item.classList.toggle("active",selected);item.setAttribute("aria-selected",String(selected));item.tabIndex=selected?0:-1});load()}
function moveSourceFocus(event){if(!["ArrowDown","ArrowUp","ArrowRight","ArrowLeft"].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll(".source")],current=tabs.indexOf(event.currentTarget),delta=event.key==="ArrowDown"||event.key==="ArrowRight"?1:-1;const next=tabs[(current+delta+tabs.length)%tabs.length];next.focus();selectSource(next)}
document.querySelectorAll(".source").forEach(button=>{button.onclick=()=>selectSource(button);button.onkeydown=moveSourceFocus});$("run").onclick=run;$("refresh").onclick=load;$("previous").onclick=()=>moveFrame(-1);$("next").onclick=()=>moveFrame(1);$("test-search").oninput=renderTestNav;init();
</script></body></html>`;

import { createServer, type ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import { FactorioDatabase } from "./Database.ts";
import { ConveyorStore } from "./Store.ts";
import type { Blob, Receipt } from "./Types.ts";
import { discoverPipeline } from "./Pipeline.ts";
import type { TestHarness } from "../test/harness/CreateTestHarness.ts";
import { getVisualTest, listVisualTests, runVisualTest } from "../test/visual/TestCatalog.ts";
