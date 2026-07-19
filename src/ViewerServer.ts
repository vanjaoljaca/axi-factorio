type ViewStep = { id: string; label: string };
type ViewBlob = {
  id: string;
  title: string;
  pipeline: string;
  status: string;
  stepId: string;
  steps: ViewStep[];
  completedStepIds: string[];
  updatedAt: string;
};
type ViewProject = {
  id: string;
  name: string;
  blobs: ViewBlob[];
};
type ProjectRecord = { id: string; name: string };
type ProjectAwareBlob = Blob & { projectId?: string };
type ProjectAwareStore = ConveyorStore & { listProjects?: () => ProjectRecord[] };

const port = Number(argument("--port") ?? "4317");
const databasePath = resolve(argument("--db") ?? "pipelines/axi-factorio.db");
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/api/view") return json(response, viewSnapshot());
    if (url.pathname === "/") return html(response, viewerHtml);
    response.writeHead(404).end("Not found");
  } catch (error) {
    json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  log("viewer.ready", { url: `http://127.0.0.1:${port}`, databasePath });
});

function viewSnapshot(): object {
  const database = new FactorioDatabase(databasePath);
  try {
    const store = new ConveyorStore(database);
    const blobs = store.listBlobs();
    const receipts = store.listReceipts();
    const projects = groupProjects(blobs, receipts, listProjects(store));
    return {
      name: "Factorio Command Center",
      stats: { tasks: blobs.length, projects: projects.length },
      projects,
    };
  } finally {
    database.close();
  }
}

function listProjects(store: ConveyorStore): ProjectRecord[] {
  return (store as ProjectAwareStore).listProjects?.() ?? [];
}

function groupProjects(blobs: Blob[], receipts: Receipt[], records: ProjectRecord[]): ViewProject[] {
  const projects = new Map(records.map((record) => [record.id, {
    id: record.id, name: record.name, blobs: [],
  }]));
  for (const blob of blobs) {
    const id = (blob as ProjectAwareBlob).projectId ?? projectId(blob.cwd);
    const record = records.find((candidate) => candidate.id === id);
    const project = projects.get(id) ?? { id, name: record?.name ?? projectName(id), blobs: [] };
    project.blobs.push(viewBlob(blob, receipts));
    projects.set(id, project);
  }
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function projectId(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const appsIndex = parts.lastIndexOf("apps");
  return appsIndex >= 0 && parts[appsIndex + 1]
    ? parts[appsIndex + 1]
    : parts.at(-1) ?? "workspace";
}

function projectName(id: string): string {
  return id
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function viewBlob(blob: Blob, receipts: Receipt[]): ViewBlob {
  const relevant = receipts.filter((receipt) => receipt.blobId === blob.id && !receipt.invalidatedAt);
  const steps = discoverPipeline(blob.pipelinePath).map((step) => ({
    id: step.id,
    label: stepLabel(step.id),
  }));
  return {
    id: blob.id,
    title: blob.title,
    pipeline: blob.pipelineId,
    status: displayStatus(blob, relevant),
    stepId: blob.state,
    steps: [...steps, { id: "complete", label: "Done" }],
    completedStepIds: relevant.filter((receipt) => receipt.status === "advance").map((receipt) => receipt.stepId),
    updatedAt: blob.updatedAt,
  };
}

function stepLabel(id: string): string {
  const label = id.split(".").at(-1) ?? id;
  return label.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayStatus(blob: Blob, receipts: Receipt[]): string {
  if (blob.state === "complete") return "Done";
  if (receipts.at(-1)?.status === "running") return "In progress";
  if (blob.paused) return "Needs attention";
  return "Planned";
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

const viewerHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Factorio Command Center</title><style>
:root{color-scheme:light;--canvas:#fff;--rail:#fbfbfb;--panel:#fff;--line:#e6e8e6;--line-strong:#daddda;--muted:#747b76;--quiet:#aeb4b0;--ink:#171a18;--green:#0caf69;--green-soft:#e2f6ed;--selected:#eef0ef;--danger:#cf4e4e}
*{box-sizing:border-box}html,body{min-height:100%}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.4 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}.app{min-height:100vh;display:grid;grid-template-columns:164px minmax(0,1fr)}.rail{position:fixed;inset:0 auto 0 0;width:164px;border-right:1px solid var(--line);background:var(--rail);padding:35px 14px}.brandmark{margin:0 8px 34px;font-size:13px;font-weight:750;letter-spacing:-.02em}
.nav{display:grid;gap:8px}.nav button{height:42px;border:0;border-radius:7px;background:transparent;text-align:left;padding:0 12px;cursor:pointer;color:#444945}.nav button:hover{background:#f3f4f3}.nav button.active{background:var(--selected);color:var(--ink);font-weight:600}
.main{grid-column:2;min-width:0}.topbar{height:72px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 30px;gap:24px}.identity{min-width:235px}.identity strong{display:block;font-size:18px;line-height:1.25;letter-spacing:-.025em}.online{font-size:11px;color:var(--muted)}.online:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:6px}.search{position:relative;margin-left:auto;width:min(326px,36vw)}.search input{width:100%;height:35px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:0 39px 0 12px;outline:none;box-shadow:0 1px 2px #00000005}.search input:focus{border-color:#aeb7b1;box-shadow:0 0 0 3px #0caf6914}.shortcut{position:absolute;right:8px;top:7px;width:21px;height:21px;border:1px solid var(--line-strong);border-radius:4px;text-align:center;color:var(--muted);font-size:11px;line-height:19px}.refresh{height:35px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:0 12px;cursor:pointer;color:var(--muted);font-size:11px}.refresh:hover{background:#f8f9f8;color:var(--ink)}.refresh:focus-visible{outline:3px solid #0caf6920}
.content{padding:20px 30px 40px;max-width:1180px}.intro{margin-bottom:30px}.intro h1{font-size:18px;line-height:1.25;margin:0 0 2px;letter-spacing:-.02em}.intro p{margin:0;color:var(--muted);font-size:12px}.table-labels{display:grid;grid-template-columns:minmax(250px,1.05fr) minmax(390px,1.4fr) 110px 70px;gap:20px;padding:0 12px 10px;font-size:11px;font-weight:600}.project-list{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}.project+.project{border-top:1px solid var(--line)}
.project-head{width:100%;height:48px;display:grid;grid-template-columns:minmax(250px,1.05fr) minmax(390px,1.4fr) 110px 70px;gap:20px;align-items:center;padding:0 12px;border:0;background:#fff;text-align:left;cursor:pointer}.project-head:hover{background:#fafbfa}.project-title{display:flex;align-items:center;gap:10px;font-weight:650}.count{font-size:11px;color:var(--muted);font-weight:400}.pipeline-labels{display:grid;align-items:center;grid-template-columns:repeat(var(--steps),minmax(52px,1fr));color:#505651;font-size:10px;text-align:center}.chevron{grid-column:4;justify-self:end;color:var(--muted);font-size:10px}.project.collapsed .taskrows{display:none}
.taskrow{min-height:43px;display:grid;grid-template-columns:minmax(250px,1.05fr) minmax(390px,1.4fr) 110px 70px;gap:20px;align-items:center;padding:0 12px;border-top:1px solid var(--line)}.taskrow:hover{background:#fcfdfc}.task-title{min-width:0;padding-left:34px}.title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}.track{display:grid;grid-template-columns:repeat(var(--steps),minmax(52px,1fr));position:relative;height:20px;align-items:center}.cell{height:20px;position:relative}.cell:before{content:"";position:absolute;left:0;right:0;top:10px;height:1px;background:var(--line-strong)}.cell:first-child:before{left:50%}.cell:last-child:before{right:50%}.bead{position:absolute;left:50%;top:5px;transform:translateX(-50%);z-index:1;width:10px;height:10px;border-radius:50%;background:#b7bcb8}.bead.done{background:var(--green)}.bead.current{top:3px;width:14px;height:14px;border:2px solid #fff;background:var(--green);box-shadow:0 0 0 1px var(--green),0 0 0 4px var(--green-soft)}.bead.attention{background:#fff;box-shadow:0 0 0 1px var(--danger),0 0 0 4px #cf4e4e15}.status{white-space:nowrap;color:#69706b;font-size:11px}.status:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:8px;background:#b7bcb8;vertical-align:1px}.status.done:before,.status.in-progress:before{background:var(--green)}.status.planned:before{background:#fff;border:1px solid #9da49f}.status.needs-attention{color:var(--danger)}.status.needs-attention:before{background:var(--danger)}.updated{font-size:10px;color:var(--muted);white-space:nowrap;text-align:right}
.footer{display:flex;align-items:center;min-height:55px;padding:13px 12px 0;color:var(--muted);font-size:10px}.legend{display:flex;align-items:center;gap:18px}.legend span{display:flex;align-items:center;gap:7px}.key{width:10px;height:10px;border-radius:50%;background:#b7bcb8}.key.complete{background:var(--green)}.key.progress{background:var(--green);border:2px solid #fff;box-shadow:0 0 0 1px var(--green),0 0 0 3px var(--green-soft)}.key.skipped{background:#fff;border:1px solid #aeb4b0}.total{margin-left:auto;margin-right:15px}.view-runs{height:32px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:0 12px;cursor:pointer;font-size:11px}.view-runs:hover{background:#f7f8f7}.empty{padding:70px 24px;text-align:center;color:var(--muted)}.empty b{display:block;color:var(--ink);font-size:14px;margin-bottom:4px}.no-results{padding:32px;text-align:center;color:var(--muted);font-size:12px}.error{margin-top:18px;padding:12px;border:1px solid #f0cdcd;border-radius:7px;background:#fff7f7;color:#9e3f3f;font-size:12px}
@media(max-width:900px){.app{grid-template-columns:72px minmax(0,1fr)}.rail{width:72px;padding-inline:10px}.nav button{padding:0;text-align:center;font-size:0}.nav-kicker{margin:0;font-size:10px}.main{grid-column:2}.identity{min-width:190px}.content,.topbar{padding-left:20px;padding-right:20px}.table-labels{display:none}.project-head,.taskrow{grid-template-columns:minmax(180px,.8fr) minmax(300px,1.4fr) 105px}.project-head{height:52px}.project-head .chevron{grid-column:3}.project-head .pipeline-labels{display:none}.updated{display:none}.task-title{padding-left:22px}.footer{padding-top:16px;flex-wrap:wrap;gap:14px}}
@media(max-width:650px){.app{display:block}.rail{position:static;width:100%;height:58px;border:0;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:8px 14px}.brandmark{margin:0 18px 0 0}.nav{display:flex;gap:4px}.nav button{width:42px}.main{display:block}.topbar{height:auto;min-height:82px;flex-wrap:wrap;padding:14px 18px;gap:10px}.identity{min-width:calc(100% - 54px)}.search{order:3;width:100%;margin:0}.content{padding:20px 14px}.project-list{overflow-x:auto}.project{min-width:650px}.footer{min-width:650px}}
</style></head><body><div class="app">
<aside class="rail" aria-label="Primary navigation"><div class="brandmark">axi-factorio</div><nav class="nav">
<button class="active" data-nav="overview">Overview</button>
<button data-nav="projects">Projects</button>
<button data-nav="runs">Runs</button>
<button data-nav="settings">Settings</button>
</nav></aside>
<main class="main"><header class="topbar"><div class="identity"><strong>Factorio Command Center</strong><span class="online">Online</span></div>
<label class="search"><span class="shortcut">/</span><input id="search" type="search" placeholder="Search projects or tasks…" aria-label="Search projects or tasks"></label>
<button class="refresh" id="refresh">Refresh</button></header>
<section class="content"><div class="intro"><h1>Overview</h1><p id="summary">Loading your workspace…</p></div>
<div class="table-labels"><span>Project / Task</span><span>Pipeline</span><span>Status</span><span>Updated</span></div>
<div class="project-list" id="projects"><div class="empty"><b>Loading workspace</b>Your tasks will appear here.</div></div>
<div class="footer"><div class="legend"><span><i class="key complete"></i>Complete</span><span><i class="key progress"></i>In progress</span><span><i class="key"></i>Pending</span><span><i class="key skipped"></i>Skipped</span></div><span class="total" id="total"></span><button class="view-runs" id="view-runs">View Runs</button></div>
<div id="error" role="status"></div></section></main></div>
<script>
const byId=id=>document.getElementById(id);let snapshot=null;
async function load(){try{const response=await fetch('/api/view');if(!response.ok)throw new Error('Could not refresh the workspace.');snapshot=await response.json();render();byId('error').innerHTML=''}catch(error){byId('error').innerHTML='<div class="error">'+escapeHtml(error.message)+'</div>'}}
function render(){const query=byId('search').value.trim().toLowerCase();const projects=snapshot.projects.map(project=>({...project,blobs:project.blobs.filter(blob=>!query||project.name.toLowerCase().includes(query)||blob.title.toLowerCase().includes(query)||blob.id.toLowerCase().includes(query))})).filter(project=>project.blobs.length||!query||project.name.toLowerCase().includes(query));byId('summary').textContent='1 command center · '+snapshot.stats.projects+' '+plural(snapshot.stats.projects,'project')+' · '+snapshot.stats.tasks+' '+plural(snapshot.stats.tasks,'task');byId('total').textContent=snapshot.stats.tasks+' '+plural(snapshot.stats.tasks,'task')+' total';byId('projects').innerHTML=projects.length?projects.map(projectCard).join(''):'<div class="no-results">'+(query?'No projects or tasks match your search.':'No projects yet. New work will appear here automatically.')+'</div>'}
function projectCard(project){const steps=sharedSteps(project.blobs);return '<section class="project" data-project="'+escapeHtml(project.id)+'"><button class="project-head" aria-expanded="true"><span class="project-title">'+escapeHtml(project.name)+' <small class="count">'+project.blobs.length+' '+plural(project.blobs.length,'task')+'</small></span><span class="pipeline-labels" style="--steps:'+steps.length+'">'+steps.map(step=>'<span>'+escapeHtml(step.label)+'</span>').join('')+'</span><span class="chevron">Hide</span></button><div class="taskrows">'+project.blobs.map(blob=>taskRow(blob,steps)).join('')+'</div></section>'}
function sharedSteps(blobs){return blobs.reduce((chosen,blob)=>blob.steps.length>chosen.length?blob.steps:chosen,[])}
function taskRow(blob,steps){const beads=steps.map(step=>{const known=blob.steps.some(candidate=>candidate.id===step.id);const atStep=blob.stepId===step.id;const planned=atStep&&blob.status==='Planned';const complete=blob.stepId==='complete'||blob.completedStepIds.includes(step.id)||planned;const current=atStep&&!planned&&blob.status!=='Done';const attention=current&&blob.status==='Needs attention';return '<span class="cell"><i class="bead '+(complete?'done ':'')+(current?'current ':'')+(attention?'attention ':'')+(!known?'skipped':'')+'"></i></span>'}).join('');const statusClass=blob.status.toLowerCase().replaceAll(' ','-');return '<div class="taskrow"><div class="task-title"><span class="title" title="'+escapeHtml(blob.title)+'">'+escapeHtml(blob.title)+'</span></div><div class="track" style="--steps:'+steps.length+'">'+beads+'</div><span class="status '+statusClass+'">'+escapeHtml(blob.status)+'</span><time class="updated" datetime="'+escapeHtml(blob.updatedAt)+'">'+relativeTime(blob.updatedAt)+'</time></div>'}
function relativeTime(value){const seconds=Math.max(0,Math.round((Date.now()-Date.parse(value))/1000));if(seconds<60)return 'now';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';const days=Math.floor(seconds/86400);return days<30?days+'d ago':new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'})}
function plural(count,word){return count===1?word:word+'s'}function escapeHtml(value){const node=document.createElement('span');node.textContent=String(value);return node.innerHTML}
byId('refresh').onclick=load;byId('view-runs').onclick=()=>{byId('search').focus()};byId('search').oninput=render;document.addEventListener('keydown',event=>{if(event.key==='/'&&document.activeElement!==byId('search')){event.preventDefault();byId('search').focus()}});
byId('projects').onclick=event=>{const head=event.target.closest('.project-head');if(!head)return;const project=head.closest('.project');project.classList.toggle('collapsed');const expanded=!project.classList.contains('collapsed');head.setAttribute('aria-expanded',String(expanded));head.querySelector('.chevron').textContent=expanded?'Hide':'Show'};
document.querySelectorAll('[data-nav]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-nav]').forEach(item=>item.classList.remove('active'));button.classList.add('active');if(button.dataset.nav!=='overview')byId('search').focus()});
load();setInterval(load,5000);
</script></body></html>`;

import type { ServerResponse } from "node:http";
import type { Blob, Receipt } from "./Types.ts";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { FactorioDatabase } from "./Database.ts";
import { discoverPipeline } from "./Pipeline.ts";
import { ConveyorStore } from "./Store.ts";
