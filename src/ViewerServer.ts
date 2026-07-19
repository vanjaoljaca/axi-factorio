type ViewStep = { id: string; label: string; group: string; groupLabel: string };
type ViewGroup = { id: string; label: string; count: number };
type ViewBlob = {
  id: string;
  title: string;
  stepId: string;
  paused: boolean;
  running: boolean;
  status: "ready" | "held" | "running" | "waiting" | "blocked" | "failed" | "complete";
  completedStepIds: string[];
  importedStepIds: string[];
  steps: ViewStep[];
};
type ViewProject = {
  id: string;
  name: string;
  root: string;
  pipelineRoot: string;
  defaultPipeline: string;
  resolvedPipeline: string | null;
  resolvedPipelinePath: string | null;
  steps: ViewStep[];
  blobs: ViewBlob[];
};

export function createViewSnapshot(databasePath: string): object {
  const database = new FactorioDatabase(databasePath);
  try {
    const store = new ConveyorStore(database);
    const receipts = store.listReceipts();
    const projects = groupProjects(store.listProjects(), store.listBlobs(), receipts);
    const steps = sharedSteps(projects);
    return {
      name: "Factorio Dashboard",
      stats: { tasks: projects.reduce((sum, project) => sum + project.blobs.length, 0), projects: projects.length },
      groups: stepGroups(steps),
      steps,
      projects,
    };
  } finally {
    database.close();
  }
}

function startViewer(): void {
  const port = Number(argument("--port") ?? "4317");
  const databasePath = resolve(argument("--db") ?? "pipelines/axi-factorio.db");
  process.title = "axi-factorio-viewer";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === "/api/view") return json(response, createViewSnapshot(databasePath));
      if (url.pathname === "/") return html(response, viewerHtml);
      response.writeHead(404).end("Not found");
    } catch (error) {
      json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    log("viewer.ready", { url: `http://127.0.0.1:${port}`, databasePath });
  });
}

function groupProjects(records: Project[], blobs: Blob[], receipts: Receipt[]): ViewProject[] {
  const projects = new Map(records.map((project) => [
    project.id,
    viewProject(project),
  ]));
  for (const blob of blobs) {
    const project = projects.get(blob.projectId) ?? fallbackProject(blob);
    project.blobs.push(viewBlob(blob, receipts));
    projects.set(project.id, project);
  }
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function viewProject(project: Project): ViewProject {
  const selection = projectPipelineSelection(project);
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    pipelineRoot: project.pipelineRoot,
    defaultPipeline: project.defaultPipeline,
    resolvedPipeline: selection?.id ?? null,
    resolvedPipelinePath: selection?.path ?? null,
    steps: selection ? discoverPipeline(selection.path).map(viewStep) : [],
    blobs: [],
  };
}

function fallbackProject(blob: Blob): ViewProject {
  const id = blob.projectId || projectId(blob.cwd);
  return {
    id,
    name: projectName(id),
    root: blob.cwd,
    pipelineRoot: dirname(blob.pipelinePath),
    defaultPipeline: blob.pipelineId,
    resolvedPipeline: blob.pipelineId,
    resolvedPipelinePath: blob.pipelinePath,
    steps: discoverPipeline(blob.pipelinePath).map(viewStep),
    blobs: [],
  };
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
  const latest = relevant.at(-1);
  return {
    id: blob.id,
    title: blob.title,
    stepId: blob.state,
    paused: blob.paused,
    running: latest?.status === "running",
    status: viewStatus(blob, latest),
    completedStepIds: relevant.filter((receipt) => receipt.status === "advance").map((receipt) => receipt.stepId),
    importedStepIds: relevant.filter((receipt) =>
      receipt.status === "advance" && receipt.executionKind === "imported").map((receipt) => receipt.stepId),
    steps: discoverPipeline(blob.pipelinePath).map(viewStep),
  };
}

function viewStatus(blob: Blob, latest?: Receipt): ViewBlob["status"] {
  if (blob.state === "complete") return "complete";
  if (latest?.status === "failed") return "failed";
  if (blob.paused && !latest) return "held";
  if (blob.paused && (blob.humanGateStepId === blob.state || latest?.executionKind === "imported")) {
    return "waiting";
  }
  if (latest?.status === "blocked" || blob.paused) return "blocked";
  if (latest?.status === "running") return "running";
  return "ready";
}

function viewStep(step: StepDefinition): ViewStep {
  const [group = "pipeline", name = step.id] = step.id.split(".");
  return {
    id: step.id,
    label: titleCase(name),
    group,
    groupLabel: titleCase(group),
  };
}

function sharedSteps(projects: ViewProject[]): ViewStep[] {
  const ordered = new Map<string, ViewStep>();
  for (const project of projects) {
    for (const step of project.steps) if (!ordered.has(step.id)) ordered.set(step.id, step);
    for (const blob of project.blobs) {
      for (const step of blob.steps) if (!ordered.has(step.id)) ordered.set(step.id, step);
    }
  }
  return [...ordered.values()];
}

function projectPipelineSelection(project: Project): { id: string; path: string } | null {
  try {
    const selected = join(project.pipelineRoot, project.defaultPipeline);
    const path = /^v\d+$/.test(basename(selected)) && isDirectory(selected)
      ? selected
      : latestVersion(selected);
    return { id: relative(project.pipelineRoot, path).split(sep).join("/"), path };
  } catch (error) {
    log("viewer.pipeline_unavailable", {
      projectId: project.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function latestVersion(selected: string): string {
  const versions = readdirSync(selected, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
    .sort((left, right) => Number(right.name.slice(1)) - Number(left.name.slice(1)));
  if (!versions[0]) throw new Error(`Pipeline ${selected} has no vN versions.`);
  return join(selected, versions[0].name);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function stepGroups(steps: ViewStep[]): ViewGroup[] {
  const groups: ViewGroup[] = [];
  for (const step of steps) {
    const current = groups.at(-1);
    if (current?.id === step.group) current.count += 1;
    else groups.push({ id: step.group, label: step.groupLabel, count: 1 });
  }
  return groups;
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").split(" ").map((word) => {
    if (word === "ios") return "iOS";
    if (["qa", "e2e", "api"].includes(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
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

const viewerHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Factorio Dashboard</title><style>
:root{color-scheme:light;--canvas:#fff;--rail:#fbfcfb;--line:#e7ebe8;--line-strong:#dce2de;--muted:#737d77;--quiet:#bfc6c2;--ink:#18201b;--green:#0caf69;--blue:#2d95ea;--neutral-soft:#eef1ef;--attention:#c87918;--attention-soft:#faecd9;--danger:#ce5353;--danger-soft:#f8e7e7}
*{box-sizing:border-box}html,body{min-height:100%}body{margin:0;background:var(--canvas);color:var(--ink);font:12px/1.4 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}.app{min-height:100vh;display:grid;grid-template-columns:132px minmax(0,1fr)}.rail{position:fixed;inset:0 auto 0 0;width:132px;height:100vh;border-right:1px solid var(--line);background:var(--rail);padding:20px 10px;display:flex;flex-direction:column}.brand{margin:0 9px 24px;font-size:14px;font-weight:780;letter-spacing:-.03em}.nav{display:grid;gap:5px}.nav-item{height:35px;display:flex;align-items:center;padding:0 10px;border-radius:6px;color:#626c66;font-size:10px}.nav-item.active{background:#eaf3fe;color:#2781c8;font-weight:650}.agent{margin-top:auto;border:1px solid var(--line);border-radius:6px;padding:8px 9px;font-size:9px}.agent strong{display:block}.agent span{color:var(--green)}
.main{grid-column:2;min-width:0}.topbar{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 22px;gap:8px}.identity{display:flex;align-items:center;gap:8px;min-width:220px}.identity strong{font-size:13px;letter-spacing:-.02em}.online{font-size:9px;color:var(--muted)}.online:before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--green);margin-right:5px;vertical-align:1px}.search{margin-left:auto;width:min(320px,38vw)}.search input{width:100%;height:30px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:0 10px;outline:none}.search input:focus{border-color:#9eb9aa;box-shadow:0 0 0 3px #0caf6914}.refresh{height:30px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:0 10px;cursor:pointer;color:var(--muted)}.refresh:hover{background:#f7f9f8;color:var(--ink)}
.content{padding:14px 20px 26px;min-width:0}.toolbar{height:34px;display:flex;align-items:center}.toolbar strong{font-size:11px}.workspace{border:1px solid var(--line);background:#fff;overflow:auto;max-width:100%}.matrix{width:100%}.matrix-head{display:grid;grid-template-columns:170px repeat(var(--steps),minmax(72px,1fr));position:sticky;top:0;z-index:3;background:#fff}.corner{grid-row:span 2;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.band{height:30px;display:flex;align-items:center;justify-content:center;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:#f7f8f7;color:#5f6963}.step{height:56px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:center;padding:7px;text-align:center;color:#505b55;font-size:9px;line-height:1.25}.project+.project{border-top:1px solid var(--line)}.project-head{position:sticky;left:0;z-index:2;width:100%;height:37px;display:flex;align-items:center;border:0;background:#fff;padding:0 10px;text-align:left;font-weight:700;font-size:10px;cursor:pointer}.project-head:hover{background:#fafbfa}.project-head .count{margin-left:6px;color:var(--muted);font-weight:400}.project-head .toggle{margin-left:auto;color:var(--muted);font-size:9px}.project.collapsed .taskrows{display:none}
.taskrow{display:grid;grid-template-columns:170px repeat(var(--steps),minmax(72px,1fr));height:34px;align-items:center}.taskrow:hover{background:#fcfdfc}.task-title{position:sticky;left:0;z-index:2;height:34px;display:flex;align-items:center;gap:6px;background:inherit;padding:0 10px 0 24px;color:#3f4944;font-size:10px}.task-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-status{margin-left:auto;flex:none;color:var(--muted);font-size:8px}.task-status.waiting,.task-status.blocked{color:var(--attention);font-weight:700}.task-status.failed{color:var(--danger);font-weight:700}.taskrow:hover .task-title{background:#fcfdfc}.track-cell{height:34px;position:relative}.track-cell:before{content:"";position:absolute;left:0;right:0;top:17px;height:1px;background:var(--line-strong)}.track-cell.first:before{left:50%}.track-cell.last:before{right:50%}.bead{position:absolute;z-index:1;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%;background:var(--quiet)}.bead.done{width:12px;height:12px;margin:-6px;background:var(--ink)}.bead.done:after{content:"✓";position:absolute;inset:-1px 0 0;color:#fff;text-align:center;font-size:8px;font-style:normal;font-weight:800}.bead.done.imported{border-radius:2px;background:#fff;border:1.5px dashed #69736d;transform:rotate(45deg)}.bead.done.imported:after{color:#56605a;transform:rotate(-45deg)}.bead.current{width:12px;height:12px;margin:-6px;background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.bead.current.running{background:var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.bead.current.waiting,.bead.current.blocked{border-style:double;border-color:var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}.bead.current.failed{border-color:var(--danger);box-shadow:0 0 0 2px var(--danger-soft)}.bead.current.failed:after{content:"×";position:absolute;inset:-4px 0 0;color:var(--danger);text-align:center;font-size:11px;font-style:normal;font-weight:800}.bead.unavailable{background:#fff;border:1px solid #c7ceca}.empty-project{padding:11px 24px;color:var(--muted);font-size:10px}.footer{display:flex;align-items:center;gap:18px;padding:12px 4px 0;color:var(--muted);font-size:9px}.legend{display:flex;align-items:center;gap:15px;flex-wrap:wrap}.legend span{display:flex;align-items:center;gap:6px}.key{position:relative;width:8px;height:8px;border-radius:50%;background:var(--quiet)}.key.complete{width:11px;height:11px;background:var(--ink)}.key.complete:after{content:"✓";position:absolute;inset:-2px 0 0;color:#fff;text-align:center;font-size:8px}.key.imported{width:10px;height:10px;border-radius:2px;background:#fff;border:1px dashed #69736d;transform:rotate(45deg)}.key.inventory{width:10px;height:10px;border-radius:2px;background:#fff;border:1px solid var(--quiet)}.key.current{width:11px;height:11px;background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.key.waiting{width:11px;height:11px;background:#fff;border:3px double var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}.key.failed{width:11px;height:11px;background:#fff;border:1px solid var(--danger)}.total{margin-left:auto}.empty{padding:72px 24px;text-align:center;color:var(--muted)}.empty b{display:block;color:var(--ink);font-size:12px;margin-bottom:4px}.no-results{padding:42px 24px;text-align:center;color:var(--muted)}.error{margin-top:12px;padding:10px;border:1px solid #efcece;border-radius:6px;background:#fff7f7;color:#9d3f3f}
@media(max-width:760px){.app{grid-template-columns:76px minmax(0,1fr)}.rail{width:76px;padding-inline:7px}.brand{margin-inline:4px}.nav-item{justify-content:center;padding:0;font-size:9px}.agent{display:none}.identity{min-width:auto}.identity strong{font-size:11px}.content{padding-inline:12px}.topbar{padding-inline:12px}.search{width:min(240px,45vw)}}
@media(max-width:520px){.app{display:block}.rail{position:static;width:100%;height:48px;border-right:0;border-bottom:1px solid var(--line);display:flex;flex-direction:row;align-items:center;padding:6px 10px}.brand{margin:0 14px 0 0}.nav{display:flex}.nav-item{height:30px;padding:0 8px}.nav-item:not(.active){display:none}.main{display:block}.topbar{height:auto;min-height:92px;flex-wrap:wrap;padding-block:12px}.identity{width:calc(100% - 72px)}.search{order:3;width:100%;margin:0}.content{padding-top:10px}.matrix-head{grid-template-columns:145px repeat(var(--steps),minmax(66px,1fr))}.taskrow{grid-template-columns:145px repeat(var(--steps),minmax(66px,1fr))}.task-title{padding-left:14px}}
</style></head><body><div class="app">
<aside class="rail" aria-label="Primary navigation"><div class="brand">axi-factorio</div><nav class="nav">
<span class="nav-item active">Overview</span><span class="nav-item">Projects</span><span class="nav-item">Runs</span><span class="nav-item">Alerts</span><span class="nav-item">Settings</span>
</nav><div class="agent"><strong>Factorio</strong><span>Service online</span></div></aside>
<main class="main"><header class="topbar"><div class="identity"><strong>Factorio Dashboard</strong><span class="online">Online</span></div>
<label class="search"><input id="search" type="search" placeholder="Search projects or tasks…" aria-label="Search projects or tasks"></label>
<button class="refresh" id="refresh">Refresh</button></header>
<section class="content"><div class="toolbar"><strong>All Projects</strong></div>
<div class="workspace" id="workspace"><div class="empty"><b>Loading workspace</b>Your projects will appear here.</div></div>
<div class="footer"><div class="legend"><span><i class="key complete"></i>Completed</span><span><i class="key imported"></i>Imported</span><span><i class="key inventory"></i>Inventory</span><span><i class="key current"></i>Current</span><span><i class="key waiting"></i>Awaiting review / needs attention</span><span><i class="key"></i>Pending</span><span><i class="key failed"></i>Failed</span></div><span class="total" id="total"></span></div>
<div id="error" role="status"></div></section></main></div>
<script>
const byId=id=>document.getElementById(id);let snapshot=null;
async function load(){try{const response=await fetch('/api/view');if(!response.ok)throw new Error('Could not refresh the workspace.');snapshot=await response.json();render();byId('error').innerHTML=''}catch(error){byId('error').innerHTML='<div class="error">'+escapeHtml(error.message)+'</div>'}}
function render(){const query=byId('search').value.trim().toLowerCase();const projects=snapshot.projects.map(project=>({...project,blobs:project.blobs.filter(blob=>matches(blob,project,query))})).filter(project=>project.blobs.length||(!query&&snapshot.projects.length)||project.name.toLowerCase().includes(query));byId('total').textContent=snapshot.stats.tasks+' '+plural(snapshot.stats.tasks,'task')+' across '+snapshot.stats.projects+' '+plural(snapshot.stats.projects,'project');byId('workspace').innerHTML=projects.length?matrix(projects):'<div class="no-results">'+(query?'No projects or tasks match your search.':'No projects yet. Add a project and its work will appear here.')+'</div>'}
function matches(blob,project,query){return !query||project.name.toLowerCase().includes(query)||blob.title.toLowerCase().includes(query)||blob.id.toLowerCase().includes(query)}
function matrix(projects){const steps=snapshot.steps;return '<div class="matrix" style="--steps:'+Math.max(steps.length,1)+'"><div class="matrix-head" style="--steps:'+Math.max(steps.length,1)+'"><div class="corner"></div>'+snapshot.groups.map(group=>'<div class="band" style="grid-column:span '+group.count+'">'+escapeHtml(group.label)+'</div>').join('')+steps.map(step=>'<div class="step">'+escapeHtml(step.label)+'</div>').join('')+'</div>'+projects.map(projectCard).join('')+'</div>'}
function projectCard(project){const rows=project.blobs.length?project.blobs.map(taskRow).join(''):'<div class="empty-project">No tasks in this project.</div>';return '<section class="project" data-project="'+escapeHtml(project.id)+'"><button class="project-head" aria-expanded="true"><span>'+escapeHtml(project.name)+'</span><span class="count">'+project.blobs.length+'</span><span class="toggle">Hide</span></button><div class="taskrows">'+rows+'</div></section>'}
function taskRow(blob){const cells=snapshot.steps.map((step,index)=>beadCell(blob,step,index)).join('');const label=statusLabel(blob.status);return '<div class="taskrow" style="--steps:'+Math.max(snapshot.steps.length,1)+'"><div class="task-title" title="'+escapeHtml(blob.title)+'"><span class="task-name">'+escapeHtml(blob.title)+'</span>'+(label?'<small class="task-status '+blob.status+'">'+label+'</small>':'')+'</div>'+cells+'</div>'}
function beadCell(blob,step,index){const known=blob.steps.some(candidate=>candidate.id===step.id);const done=blob.stepId==='complete'||blob.completedStepIds.includes(step.id);const current=blob.stepId===step.id;const imported=done&&blob.importedStepIds.includes(step.id);const classes=['bead',done?'done':'',imported?'imported':'',current?'current':'',current?blob.status:'',!known?'unavailable':''].filter(Boolean).join(' ');return '<div class="track-cell '+(index===0?'first ':'')+(index===snapshot.steps.length-1?'last':'')+'"><i class="'+classes+'"></i></div>'}
function statusLabel(status){return {held:'Inventory',running:'Running',waiting:'Awaiting review',blocked:'Needs attention',failed:'Failed'}[status]||''}
function plural(count,word){return count===1?word:word+'s'}function escapeHtml(value){const node=document.createElement('span');node.textContent=String(value);return node.innerHTML}
byId('refresh').onclick=load;byId('search').oninput=render;document.addEventListener('keydown',event=>{if(event.key==='/'&&document.activeElement!==byId('search')){event.preventDefault();byId('search').focus()}});
byId('workspace').onclick=event=>{const head=event.target.closest('.project-head');if(!head)return;const project=head.closest('.project');project.classList.toggle('collapsed');const expanded=!project.classList.contains('collapsed');head.setAttribute('aria-expanded',String(expanded));head.querySelector('.toggle').textContent=expanded?'Hide':'Show'};
load();setInterval(load,5000);
</script></body></html>`;

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) startViewer();

import type { ServerResponse } from "node:http";
import type { Blob, Project, Receipt, StepDefinition } from "./Types.ts";
import { createServer } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FactorioDatabase } from "./Database.ts";
import { log } from "./Logger.ts";
import { discoverPipeline } from "./Pipeline.ts";
import { ConveyorStore } from "./Store.ts";
