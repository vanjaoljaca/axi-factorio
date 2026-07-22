type ViewStep = { id: string; label: string; group: string; groupLabel: string };
type ViewGroup = { id: string; label: string; count: number };
type ViewExecutionControl = {
  mode: ExecutionMode;
  requested: boolean;
  running: boolean;
  play: { enabled: boolean; explanation: string };
  step: { enabled: boolean; explanation: string };
  stop: { enabled: boolean; explanation: string };
};
type ViewBlob = {
  id: string;
  title: string;
  projectRoot: string;
  executionWorkspaceRoot: string;
  stepId: string;
  paused: boolean;
  running: boolean;
  status: "ready" | "queued" | "held" | "running" | "waiting" | "blocked" | "failed" | "complete";
  execution: ViewExecutionControl;
  open: CursorActionState;
  completedStepIds: string[];
  importedStepIds: string[];
  steps: ViewStep[];
  createdAt: string;
  latestReceiptAt: string | null;
  latestHumanInputAt: string | null;
};
type ViewAttempt = {
  receipt: Receipt;
  evidence: AttemptEvidence | null;
  events: ExecutionEvent[];
  elapsedMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};
type ViewProject = {
  id: string;
  name: string;
  root: string;
  pipelineRoot: string;
  defaultPipeline: string;
  resolvedPipeline: string | null;
  resolvedPipelinePath: string | null;
  pipelineIssue: { status: "unavailable"; summary: string; detail: string } | null;
  steps: ViewStep[];
  blobs: ViewBlob[];
};

export function createViewSnapshot(
  databasePath: string,
  cursorLauncher = new CursorWorkspaceLauncher(),
): object {
  const database = new FactorioDatabase(databasePath);
  try {
    const store = new ConveyorStore(database);
    const receipts = store.listReceipts();
    const debugMode = store.debugMode();
    const opener = store.opener();
    const activeProjectDays = store.activeProjectDays();
    const sortProjectsByProgress = store.sortProjectsByProgress();
    const projects = groupProjects(store.listProjects(), store.listBlobs(), receipts, store.listHumanInputs(), cursorLauncher, debugMode);
    const steps = sharedSteps(projects);
    const executionSessions = listExecutionSessions(store).slice(0, 12);
    const executionStatusItems = listExecutionStatusItems(store);
    return {
      name: "Factorio Dashboard",
      settings: { debugMode, activeProjectDays, sortProjectsByProgress, opener: { id: opener, label: openerLabel(opener) } },
      stats: { tasks: projects.reduce((sum, project) => sum + project.blobs.length, 0), projects: projects.length },
      groups: stepGroups(steps),
      steps,
      projects,
      executionSessions,
      executionStatusItems,
      localEndpointLeases: store.listLocalEndpointLeases(),
      executionOverviewHtml: executionOverviewMarkup(executionSessions, executionStatusItems),
    };
  } finally {
    database.close();
  }
}

export function createViewerServer(
  databasePath: string,
  cursorLauncher = new CursorWorkspaceLauncher(),
): ReturnType<typeof createServer> {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/view") {
        return json(response, createViewSnapshot(databasePath, cursorLauncher));
      }
      const learning = url.pathname.match(/^\/api\/blobs\/([^/]+)\/learning$/u);
      if (request.method === "GET" && learning) {
        return json(response, createLearningSnapshot(databasePath, decodeURIComponent(learning[1])));
      }
      if (request.method === "POST") {
        if (url.pathname === "/api/settings/debug-mode") {
          return await debugModeRequest(request, response, databasePath);
        }
        if (url.pathname === "/api/settings/opener") {
          return await openerRequest(request, response, databasePath);
        }
        if (url.pathname === "/api/settings/view") return await viewSettingsRequest(request, response, databasePath);
        return await controlRequest(request, response, databasePath, url.pathname, cursorLauncher);
      }
      if (request.method === "GET" && url.pathname === "/") return html(response, viewerHtml);
      response.writeHead(404).end("Not found");
    } catch (error) {
      const status = error instanceof BlobExecutionError ? 409 : 500;
      json(response, { error: error instanceof Error ? error.message : String(error) }, status);
    }
  });
}

async function viewSettingsRequest(request: IncomingMessage, response: ServerResponse, databasePath: string): Promise<void> {
  const body = await readBody(request);
  if (typeof body.sortProjectsByProgress !== "boolean") throw new Error("Sort projects by progress requires a boolean value.");
  const database = new FactorioDatabase(databasePath);
  try {
    const store = new ConveyorStore(database);
    const activeProjectDays = store.setActiveProjectDays(number(body.activeProjectDays));
    const sortProjectsByProgress = store.setSortProjectsByProgress(body.sortProjectsByProgress);
    json(response, { ok: true, settings: { activeProjectDays, sortProjectsByProgress } });
  } finally { database.close(); }
}

async function openerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<void> {
  const body = await readBody(request);
  const opener = text(body.opener);
  const database = new FactorioDatabase(databasePath);
  try {
    const selected = new ConveyorStore(database).setOpener(opener);
    json(response, { ok: true, settings: { opener: { id: selected, label: openerLabel(selected) } } });
  } finally {
    database.close();
  }
}

async function debugModeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<void> {
  const body = await readBody(request);
  if (typeof body.enabled !== "boolean") throw new Error("Debug mode requires a boolean enabled value.");
  const database = new FactorioDatabase(databasePath);
  try {
    const enabled = new ConveyorStore(database).setDebugMode(body.enabled);
    json(response, { ok: true, settings: { debugMode: enabled } });
  } finally {
    database.close();
  }
}

function startViewer(): void {
  const port = Number(argument("--port") ?? "4317");
  const databasePath = resolve(argument("--db") ?? "pipelines/axi-factorio.db");
  process.title = "axi-factorio-viewer";
  const server = createViewerServer(databasePath);
  server.listen(port, "127.0.0.1", () => {
    log("viewer.ready", { url: `http://127.0.0.1:${port}`, databasePath });
  });
}

export function createLearningSnapshot(databasePath: string, blobId: string): object {
  const database = new FactorioDatabase(databasePath);
  try {
    return learningSnapshot(new ConveyorStore(database), blobId);
  } finally {
    database.close();
  }
}

async function controlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
  pathname: string,
  cursorLauncher: CursorWorkspaceLauncher,
): Promise<void> {
  const match = pathname.match(/^\/api\/blobs\/([^/]+)\/(.+)$/u);
  if (!match) return void response.writeHead(404).end("Not found");
  const database = new FactorioDatabase(databasePath);
  try {
    const store = new ConveyorStore(database);
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (action === "open" || action === "open-cursor") {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        return json(response, { error: "Opening Cursor is available only from this Mac." }, 403);
      }
      const opener = store.opener();
      if (opener !== "cursor") throw new Error(`Configured opener ${opener} is unavailable.`);
      return json(response, await cursorLauncher.open(requireBlob(store, id)));
    }
    if (["play", "step", "stop"].includes(action)) {
      const result = action === "play"
        ? store.requestContinuous(id)
        : action === "step"
          ? store.requestStep(id)
          : store.requestStop(id);
      return json(response, { ok: true, already: result.already, blob: result.blob });
    }
    const body = await readBody(request);
    const preview = learningMutation(store, id, action, body);
    if (preview) return json(response, preview);
    json(response, learningSnapshot(store, id));
  } finally {
    database.close();
  }
}

function learningMutation(
  store: ConveyorStore,
  blobId: string,
  action: string,
  body: Record<string, unknown>,
): object | null {
  const blob = requireBlob(store, blobId);
  if (action === "blob/preview") return previewBlobEdit(
    store.currentBlobRevision(blob.id), text(body.title), text(body.body),
  );
  if (action === "blob/save") {
    store.reviseBlob(blob.id, text(body.title), text(body.body), number(body.expectedRevision));
    return null;
  }
  if (action === "prompt/preview") return previewPromptEdit(
    blob, text(body.stepId), promptKind(body.kind), text(body.content),
  );
  if (action === "prompt/save") {
    savePromptEdit(
      blob, text(body.stepId), promptKind(body.kind), text(body.content),
      text(body.expectedContentHash),
    );
    return null;
  }
  if (action === "rewind-step") {
    const steps = discoverPipeline(blob.pipelinePath);
    store.rewindBlob(blob.id, requireStep(steps, text(body.stepId)), steps);
    store.requestStep(blob.id);
    return null;
  }
  if (action === "retry") {
    store.retryBlob(blob.id);
    return null;
  }
  if (action === "feedback") {
    store.addHumanFeedback(blob.id, text(body.text), stringList(body.evidence), body.schedule !== false);
    return null;
  }
  if (action === "approve") {
    store.approveHumanGate(blob.id, text(body.text), stringList(body.evidence), body.schedule !== false);
    return null;
  }
  if (action === "reset-endpoint") {
    store.resetLocalEndpoint(blob.id, text(body.reason) || "Local endpoint reset from Viewer.");
    return null;
  }
  if (action === "relocate") {
    const relocation = store.relocateBlobWorkspace(blob.id, text(body.root), stringList(body.evidence));
    return { relocation, blob: store.getBlob(blob.id), project: store.getProject(blob.projectId) };
  }
  if (action === "execution-workspace") {
    const binding = store.bindExecutionWorkspace(blob.id, text(body.root), stringList(body.evidence));
    return { binding, blob: store.getBlob(blob.id), project: store.getProject(blob.projectId) };
  }
  throw new Error(`Unknown learning action: ${action}`);
}

function learningSnapshot(store: ConveyorStore, blobId: string): object {
  const blob = requireBlob(store, blobId);
  const receipts = store.listReceipts(blob.id);
  const evidence = new Map(store.listAttemptEvidence(blob.id).map((item) => [item.receiptId, item]));
  const events = store.listExecutionEvents(blob.id);
  const attempts = receipts.map((receipt) => viewAttempt(
    receipt, evidence.get(receipt.id) ?? null, events.filter((event) => event.receiptId === receipt.id),
  ));
  return {
    blob,
    revision: store.currentBlobRevision(blob.id),
    revisions: store.listBlobRevisions(blob.id),
    steps: discoverPipeline(blob.pipelinePath).map((step) => ({
      ...viewStep(step), order: step.order, entryPath: step.entryPath, exitPath: step.exitPath,
      ...snapshotDefinition(step, blob.pipelinePath),
    })),
    attempts,
    humanInputs: store.listHumanInputs(blob.id),
    localEndpointLeases: store.listLocalEndpointLeases(blob.id),
    workspaceRelocations: store.listWorkspaceRelocations(blob.id),
    executionWorkspaceBindings: store.listExecutionWorkspaceBindings(blob.id),
  };
}

function viewAttempt(
  receipt: Receipt,
  evidence: AttemptEvidence | null,
  events: ExecutionEvent[],
): ViewAttempt {
  const metrics = events.find((event) => event.attributes.eventType === "metrics")?.attributes;
  return {
    receipt,
    evidence,
    events,
    elapsedMs: receipt.finishedAt
      ? Math.max(0, Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt))
      : null,
    inputTokens: metric(metrics?.inputTokens),
    outputTokens: metric(metrics?.outputTokens),
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let value = "";
  for await (const chunk of request) {
    value += String(chunk);
    if (value.length > 1_000_000) throw new Error("Request body is too large.");
  }
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requireBlob(store: ConveyorStore, id: string): Blob {
  const blob = store.getBlob(id);
  if (!blob) throw new Error(`Blob ${id} was not found.`);
  return blob;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("A required text value is missing.");
  return value;
}

function number(value: unknown): number {
  if (!Number.isInteger(value)) throw new Error("A required integer value is missing.");
  return Number(value);
}

function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Evidence must be a list of strings.");
  }
  return value;
}

function promptKind(value: unknown): PromptKind {
  if (value !== "entry" && value !== "exit") throw new Error("Prompt kind must be entry or exit.");
  return value;
}

function metric(value: unknown): number | null {
  return typeof value === "number" && value >= 0 ? value : null;
}

function groupProjects(
  records: Project[],
  blobs: Blob[],
  receipts: Receipt[],
  humanInputs: HumanInput[],
  cursorLauncher: CursorWorkspaceLauncher,
  debugMode: boolean,
): ViewProject[] {
  const projects = new Map(records.map((project) => [
    project.id,
    viewProject(project),
  ]));
  for (const blob of blobs) {
    const project = projects.get(blob.projectId) ?? fallbackProject(blob);
    project.blobs.push(viewBlob(blob, receipts, humanInputs, cursorLauncher, debugMode));
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
    pipelineIssue: selection?.issue ?? null,
    steps: selection.path ? discoverPipeline(selection.path).map(viewStep) : [],
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
    pipelineIssue: null,
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

function viewBlob(
  blob: Blob,
  receipts: Receipt[],
  humanInputs: HumanInput[],
  cursorLauncher: CursorWorkspaceLauncher,
  debugMode: boolean,
): ViewBlob {
  const relevant = receipts.filter((receipt) => receipt.blobId === blob.id && !receipt.invalidatedAt);
  const latest = relevant.at(-1);
  const inputs = humanInputs.filter((input) => input.blobId === blob.id);
  const open = cursorLauncher.inspect(blob);
  return {
    id: blob.id,
    title: blob.title,
    projectRoot: blob.cwd,
    executionWorkspaceRoot: blob.executionWorkspaceRoot,
    stepId: blob.state,
    paused: blob.paused,
    running: latest?.status === "running",
    status: viewStatus(blob, latest),
    execution: viewExecution(blob, latest, debugMode),
    open,
    completedStepIds: relevant.filter((receipt) => receipt.status === "advance").map((receipt) => receipt.stepId),
    importedStepIds: relevant.filter((receipt) =>
      receipt.status === "advance" && receipt.executionKind === "imported").map((receipt) => receipt.stepId),
    steps: discoverPipeline(blob.pipelinePath).map(viewStep),
    createdAt: blob.createdAt,
    latestReceiptAt: latest ? latest.lastProgressAt || latest.finishedAt || latest.startedAt : null,
    latestHumanInputAt: inputs.at(-1)?.createdAt ?? null,
  };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
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
  if (blob.runRequested) return "queued";
  return "ready";
}

function viewExecution(blob: Blob, latest: Receipt | undefined, debugMode: boolean): ViewExecutionControl {
  const running = latest?.status === "running";
  const blocker = executionBlocker(blob, latest, running);
  const alreadyQueued = blob.runRequested ? "This blob is already queued." : null;
  const current = blob.state === "complete" ? "the completed blob" : blob.state;
  return {
    mode: blob.executionMode,
    requested: blob.runRequested,
    running,
    play: {
      enabled: !debugMode && !blocker && !alreadyQueued,
      explanation: debugMode
        ? "Continuous play is disabled while Debug mode is on. Use Step."
        : blocker ?? alreadyQueued ?? `Run continuously from ${current}.`,
    },
    step: {
      enabled: !blocker && !alreadyQueued,
      explanation: blocker ?? alreadyQueued ?? `Run exactly one transition at ${current}.`,
    },
    stop: {
      enabled: blob.runRequested,
      explanation: blob.runRequested
        ? running ? "Stop after the active transition." : "Cancel the queued run."
        : "This blob is already stopped.",
    },
  };
}

function executionBlocker(blob: Blob, latest: Receipt | undefined, running: boolean): string | null {
  if (blob.state === "complete") return "This blob is complete.";
  if (running) return "A transition is already running.";
  if (!blob.paused) return null;
  if (!latest) return "Inventory is held. Retry it before running.";
  if (latest.status === "failed") return "Retry the failed receipt before running.";
  if (blob.humanGateStepId === blob.state) return "Human feedback or approval is required before running.";
  return "Resolve the blocked step before running.";
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

function projectPipelineSelection(project: Project): ProjectPipelineSelection {
  try {
    const selected = join(project.pipelineRoot, project.defaultPipeline);
    const path = /^v\d+$/.test(basename(selected)) && isDirectory(selected)
      ? selected
      : latestVersion(selected);
    return { id: relative(project.pipelineRoot, path).split(sep).join("/"), path, issue: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("viewer.pipeline_unavailable", {
      projectId: project.id,
      pipelineRoot: project.pipelineRoot,
      defaultPipeline: project.defaultPipeline,
      disposition: "isolated_project",
      viewerState: "available",
      error: detail,
    });
    return {
      id: null,
      path: null,
      issue: {
        status: "unavailable",
        summary: "Pipeline unavailable",
        detail,
      },
    };
  }
}

type ProjectPipelineSelection = {
  id: string | null;
  path: string | null;
  issue: ViewProject["pipelineIssue"];
};

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

function openerLabel(opener: string): string {
  return opener === "cursor" ? "Cursor" : titleCase(opener);
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
button,input{font:inherit;color:inherit}.app{min-height:100vh;display:grid;grid-template-columns:132px minmax(0,1fr)}.rail{position:fixed;inset:0 auto 0 0;width:132px;height:100vh;border-right:1px solid var(--line);background:var(--rail);padding:20px 10px;display:flex;flex-direction:column}.brand{margin:0 9px 24px;font-size:14px;font-weight:780;letter-spacing:-.03em}.nav{display:grid;gap:5px}.nav-item{height:35px;display:flex;align-items:center;width:100%;border:0;background:transparent;padding:0 10px;border-radius:6px;color:#626c66;font-size:10px;text-align:left;cursor:pointer}.nav-item:hover{background:#f0f3f1;color:var(--ink)}.nav-item.active{background:#eaf3fe;color:#2781c8;font-weight:650}.nav-item:focus-visible{outline:2px solid #8aa6bc;outline-offset:1px}.agent{margin-top:auto;border:1px solid var(--line);border-radius:6px;padding:8px 9px;font-size:9px}.agent strong{display:block}.agent span{color:var(--green)}
.main{grid-column:2;min-width:0}.topbar{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 22px;gap:8px}.identity{display:flex;align-items:center;gap:8px;min-width:220px}.identity strong{font-size:13px;letter-spacing:-.02em}.online{font-size:9px;color:var(--muted)}.online:before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--green);margin-right:5px;vertical-align:1px}.search{margin-left:auto;width:min(320px,38vw)}.search input{width:100%;height:30px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:0 10px;outline:none}.search input:focus{border-color:#9eb9aa;box-shadow:0 0 0 3px #0caf6914}.refresh{height:30px;border:1px solid var(--line);border-radius:5px;background:#fff;padding:0 10px;cursor:pointer;color:var(--muted)}.refresh:hover{background:#f7f9f8;color:var(--ink)}
.content{padding:14px 20px 26px;min-width:0}.toolbar{height:34px;display:flex;align-items:center}.toolbar strong{font-size:11px}.workspace{border:1px solid var(--line);background:#fff;overflow:auto;max-width:100%}.workspace.plain{border:0;overflow:visible}.matrix{width:100%}.matrix-head{display:grid;grid-template-columns:280px repeat(var(--steps),minmax(72px,1fr)) 36px;position:sticky;top:0;z-index:3;background:#fff}.corner{grid-row:span 2;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.matrix-action-gutter{grid-column:-1;grid-row:1/span 2;position:sticky;right:0;z-index:4;border-left:1px solid var(--line);border-bottom:1px solid var(--line);background:#fff}.band{height:30px;display:flex;align-items:center;justify-content:center;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:#f7f8f7;color:#5f6963}.step{height:56px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:center;padding:7px;text-align:center;color:#505b55;font-size:9px;line-height:1.25}.project+.project{border-top:1px solid var(--line)}.project-head{position:sticky;left:0;z-index:2;width:100%;height:37px;display:flex;align-items:center;border:0;background:#fff;padding:0 10px;text-align:left;font-weight:700;font-size:10px;cursor:pointer}.project-head:hover{background:#fafbfa}.project-head .count{margin-left:6px;color:var(--muted);font-weight:400}.project-head .pipeline-issue{margin-left:8px;border:1px solid #e5c89f;border-radius:999px;background:#fff8ed;color:#986016;padding:2px 7px;font-size:8px;font-weight:700}.project-head .toggle{margin-left:auto;color:var(--muted);font-size:9px}.project .project-summary{display:none}.project.collapsed .taskrows{display:none}.project.collapsed .project-summary{display:grid}.aggregate-title{color:var(--muted);font-size:9px}.aggregate-bead{position:absolute;z-index:1;left:50%;top:50%;width:16px;height:16px;margin:-8px;border-radius:50%;background:var(--composition,var(--neutral-soft));box-shadow:0 0 0 1px #fff,0 0 0 2px #aeb7b1}.aggregate-bead:after{content:"";position:absolute;inset:4px;border-radius:50%;background:#fff}.aggregate-bead.unavailable{background:var(--neutral-soft);box-shadow:0 0 0 1px #fff,0 0 0 2px var(--line-strong)}
.taskrow{display:grid;grid-template-columns:280px repeat(var(--steps),minmax(72px,1fr)) 36px;height:38px;align-items:center}.taskrow:hover{background:#fcfdfc}.task-title{position:sticky;left:0;z-index:2;height:38px;display:flex;align-items:center;gap:6px;background:inherit;padding:0 8px 0 24px;color:#3f4944;font-size:10px}.task-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-name-button{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;padding:0;text-align:left;cursor:pointer}.task-name-button:hover{text-decoration:underline}.task-status{margin-left:auto;flex:none;color:var(--muted);font-size:8px}.task-status.waiting,.task-status.blocked{color:var(--attention);font-weight:700}.task-status.failed{color:var(--danger);font-weight:700}.taskrow:hover .task-title{background:#fcfdfc}.task-action-gutter{position:sticky;right:0;z-index:3;height:38px;border-left:1px solid var(--line);background:inherit}.run-controls{display:flex;gap:3px;flex:none;margin-left:3px}.control-tip{position:relative;display:inline-flex}.control-tip:focus-visible{outline:2px solid #85938a;outline-offset:1px;border-radius:5px}.control-tip:hover:after,.control-tip:focus-visible:after,.control-tip:focus-within:after{content:attr(data-tip);position:absolute;right:0;bottom:calc(100% + 6px);z-index:20;width:max-content;max-width:240px;padding:6px 8px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;color:var(--ink);box-shadow:0 4px 14px #18201b18;font-size:9px;font-weight:500;line-height:1.35;white-space:normal;pointer-events:none}.run-control{width:24px;height:24px;display:grid;place-items:center;border:1px solid var(--line-strong);border-radius:5px;background:#fff;color:#46504a;padding:0;cursor:pointer}.run-control:hover:not(:disabled){background:var(--neutral-soft);border-color:#aeb7b1}.run-control:focus-visible{outline:2px solid #85938a;outline-offset:1px}.run-control:disabled{cursor:not-allowed;color:#c0c6c2;background:#fafbfa}.run-control.mode.active{color:var(--ink);border-color:#8e9992;box-shadow:inset 0 0 0 1px #8e9992}.run-control.stop.active{color:var(--ink);border-color:#9fa9a3;background:var(--neutral-soft)}.run-control svg{width:11px;height:11px;fill:currentColor}.run-control.cursor{width:24px}.run-control.cursor svg{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.cursor-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.track-cell{height:38px;position:relative}.track-cell:before{content:"";position:absolute;left:0;right:0;top:19px;height:1px;background:var(--line-strong)}.track-cell.first:before{left:50%}.track-cell.last:before{right:50%}.bead{position:absolute;z-index:1;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%;background:var(--quiet)}.bead.done{width:12px;height:12px;margin:-6px;background:var(--ink)}.bead.done:after{content:"✓";position:absolute;inset:-1px 0 0;color:#fff;text-align:center;font-size:8px;font-style:normal;font-weight:800}.bead.done.imported{border-radius:2px;background:#fff;border:1.5px dashed #69736d;transform:rotate(45deg)}.bead.done.imported:after{color:#56605a;transform:rotate(-45deg)}.bead.current{width:12px;height:12px;margin:-6px;background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.bead.current.running{background:var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.bead.current.waiting,.bead.current.blocked{border-style:double;border-color:var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}.bead.current.failed{border-color:var(--danger);box-shadow:0 0 0 2px var(--danger-soft)}.bead.current.failed:after{content:"×";position:absolute;inset:-4px 0 0;color:var(--danger);text-align:center;font-size:11px;font-style:normal;font-weight:800}.bead.unavailable{background:#fff;border:1px solid #c7ceca}.empty-project{padding:11px 24px;color:var(--muted);font-size:10px}.footer{display:flex;align-items:center;gap:18px;padding:12px 4px 0;color:var(--muted);font-size:9px}.footer[hidden]{display:none}.legend{display:flex;align-items:center;gap:15px;flex-wrap:wrap}.legend span{display:flex;align-items:center;gap:6px}.key{position:relative;width:8px;height:8px;border-radius:50%;background:var(--quiet)}.key.complete{width:11px;height:11px;background:var(--ink)}.key.complete:after{content:"✓";position:absolute;inset:-2px 0 0;color:#fff;text-align:center;font-size:8px}.key.imported{width:10px;height:10px;border-radius:2px;background:#fff;border:1px dashed #69736d;transform:rotate(45deg)}.key.inventory{width:10px;height:10px;border-radius:2px;background:#fff;border:1px solid var(--quiet)}.key.current{width:11px;height:11px;background:#fff;border:2px solid var(--ink);box-shadow:0 0 0 2px var(--neutral-soft)}.key.waiting{width:11px;height:11px;background:#fff;border:3px double var(--attention);box-shadow:0 0 0 2px var(--attention-soft)}.key.failed{width:11px;height:11px;background:#fff;border:1px solid var(--danger)}.total{margin-left:auto}.empty{padding:72px 24px;text-align:center;color:var(--muted)}.empty b{display:block;color:var(--ink);font-size:12px;margin-bottom:4px}.no-results{padding:42px 24px;text-align:center;color:var(--muted)}.error{margin-top:12px;padding:10px;border:1px solid #efcece;border-radius:6px;background:#fff7f7;color:#9d3f3f}.action-status{margin-top:8px;color:var(--muted);font-size:9px}.action-status.success{color:#4f5b54}.action-status.failure{color:var(--danger)}.page-list{display:grid;gap:8px}.page-card{border:1px solid var(--line);border-radius:7px;background:#fff;padding:12px}.page-card-head{display:flex;align-items:center;gap:8px}.page-card-head strong{font-size:11px}.page-card-head span{margin-left:auto;color:var(--muted);font-size:9px}.page-card p{margin:5px 0 0;color:var(--muted);font-size:9px}.page-card code{font:9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.alert-card.attention{border-color:#e5c89f}.alert-card.failure{border-color:#e5b7b7}.settings-card{max-width:640px}.setting-row{display:flex;align-items:flex-start;gap:14px}.setting-copy{flex:1}.setting-copy strong{display:block;font-size:11px}.setting-copy p{margin:4px 0 0;color:var(--muted);font-size:9px}.switch{position:relative;width:34px;height:20px;flex:none}.switch input{position:absolute;opacity:0}.switch span{display:block;width:34px;height:20px;border-radius:999px;background:#c9cfcb;cursor:pointer;transition:.15s}.switch span:after{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:.15s}.switch input:checked+span{background:var(--ink)}.switch input:checked+span:after{transform:translateX(14px)}.switch input:focus-visible+span{outline:2px solid #8aa6bc;outline-offset:2px}.debug-notice{margin-top:10px;padding:8px 10px;border-radius:5px;background:#f5f7f5;color:#525d57;font-size:9px}
.learning{margin-top:16px;border:1px solid var(--line-strong);background:#fff}.learning[hidden]{display:none}.learning-head{height:42px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--line);gap:8px}.learning-head small{color:var(--muted)}.learning-head button{margin-left:auto}.learning-actions{display:flex;gap:6px;padding:9px 12px;border-bottom:1px solid var(--line)}.learning-actions button,.editor-actions button,.human-actions button,.learning-head button{height:28px;border:1px solid var(--line-strong);border-radius:4px;background:#fff;padding:0 9px;cursor:pointer}.learning-actions .primary{background:var(--ink);color:#fff}.learning-grid{display:grid;grid-template-columns:260px minmax(0,1fr)}.attempt-list{border-right:1px solid var(--line);padding:10px}.attempt-button{display:block;width:100%;border:1px solid var(--line);background:#fff;padding:8px;text-align:left;margin-bottom:6px;cursor:pointer}.attempt-button.selected{border-color:var(--ink)}.attempt-button small{display:block;color:var(--muted)}.attempt-detail{padding:10px}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.evidence-card{border:1px solid var(--line);padding:8px;min-width:0}.evidence-card.wide{grid-column:1/-1}.evidence-card small{display:block;color:var(--muted);margin-bottom:4px}.evidence-card pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:9px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.compare{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}.compare>div{padding:10px}.compare>div+div{border-left:1px solid var(--line)}.editors{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}.editor{padding:10px}.editor+.editor{border-left:1px solid var(--line)}.editor input,.editor textarea,.human-actions input{width:100%;border:1px solid var(--line-strong);padding:7px;margin:4px 0}.editor textarea{min-height:90px;resize:vertical}.editor-actions,.human-actions{display:flex;gap:6px;align-items:center}.editor-actions button:disabled{opacity:.4;cursor:not-allowed}.diff{margin-top:8px;border:1px solid var(--line);font:9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.diff div{padding:2px 6px;white-space:pre-wrap}.diff .add{background:#edf7f0}.diff .remove{background:#fff0f0}.validation{color:var(--danger);font-size:9px;margin-top:5px}.human-actions{padding:10px;border-top:1px solid var(--line)}.human-actions input{margin:0}.learning-error{margin:8px 12px;color:var(--danger)}
${liveExecutionStyles}
.matrix-head>.band{grid-row:1}.matrix-head>.step{grid-row:2}
.workspace{overflow-x:auto;overflow-y:visible}.project-fold-row{min-width:100%;height:42px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#fafbfa}.project-fold-row button{position:sticky;left:0;height:42px;border:0;background:transparent;padding:0 14px;color:#4f5a54;font-weight:700;cursor:pointer}.project-fold-row button span{display:inline-block;width:18px;color:var(--muted)}.project-fold-row button small{margin-left:7px;color:var(--muted);font-weight:500}
@media(max-width:760px){.app{grid-template-columns:76px minmax(0,1fr)}.rail{width:76px;padding-inline:7px}.brand{margin-inline:4px}.nav-item{justify-content:center;padding:0;font-size:9px}.agent{display:none}.identity{min-width:auto}.identity strong{font-size:11px}.content{padding-inline:12px}.topbar{padding-inline:12px}.search{width:min(240px,45vw)}}
@media(max-width:520px){.app{display:block}.rail{position:static;width:100%;height:48px;border-right:0;border-bottom:1px solid var(--line);display:flex;flex-direction:row;align-items:center;padding:6px 10px}.brand{margin:0 14px 0 0}.nav{display:flex}.nav-item{height:30px;padding:0 8px}.nav-item:not(.active){display:none}.main{display:block}.topbar{height:auto;min-height:92px;flex-wrap:wrap;padding-block:12px}.identity{width:calc(100% - 72px)}.search{order:3;width:100%;margin:0}.content{padding-top:10px}.matrix-head{grid-template-columns:220px repeat(var(--steps),minmax(66px,1fr))}.taskrow{grid-template-columns:220px repeat(var(--steps),minmax(66px,1fr))}.task-title{padding-left:14px}.task-status{display:none}}
.project-head-row{height:37px;display:grid;grid-template-columns:280px repeat(var(--steps),minmax(72px,1fr)) 36px;align-items:center;background:#fff}.project-identity{position:sticky;left:0;z-index:3;height:37px;display:flex;align-items:center;padding:0 12px 0 24px;background:inherit;font-weight:700;font-size:10px;min-width:0}.project-identity>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.project-identity .pipeline-issue{margin-left:8px;border:1px solid #e5c89f;border-radius:999px;background:#fff8ed;color:#986016;padding:2px 7px;font-size:8px;font-weight:700;white-space:nowrap}.project-disclosure{position:sticky;right:0;z-index:5;align-self:stretch;width:36px;height:37px;border:0;border-left:1px solid var(--line);background:#fff;color:#68726c;display:grid;place-items:center;cursor:pointer;font-size:17px;line-height:1}.project-disclosure:hover{background:var(--neutral-soft)}.project-disclosure:focus-visible{outline:2px solid #85938a;outline-offset:-3px}.project.collapsed .taskrows{display:none}.project-head-track{height:37px;position:relative}.project-head-track:before{content:"";position:absolute;left:0;right:0;top:19px;height:1px;background:var(--line-strong)}.project-head-track.first:before{left:50%}.project-head-track.last:before{right:50%}.task-name-button{display:block;max-width:100%;color:inherit}.task-name-button:focus-visible{outline:2px solid #85938a;outline-offset:2px;border-radius:2px}.blob-menu{position:fixed;z-index:1000;min-width:148px;padding:4px;border:1px solid var(--line-strong);border-radius:7px;background:#fff;box-shadow:0 10px 28px #18201b24}.blob-menu[hidden]{display:none}.blob-menu button{width:100%;height:31px;border:0;border-radius:4px;background:transparent;padding:0 10px;text-align:left;cursor:pointer;font-size:10px}.blob-menu button:hover,.blob-menu button:focus-visible{background:var(--neutral-soft);outline:0}.blob-menu button:disabled{color:#a9b0ac;cursor:not-allowed}.blob-menu small{display:block;padding:5px 10px;color:var(--muted);font-size:8px;max-width:220px}.opener-select{height:30px;min-width:130px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 28px 0 9px}@media(max-width:520px){.matrix-head,.project-head-row,.taskrow{grid-template-columns:220px repeat(var(--steps),minmax(66px,1fr)) 36px}.project-identity{padding-left:14px}.blob-menu{max-width:calc(100vw - 16px)}}
.matrix-head{grid-template-columns:280px repeat(var(--steps),minmax(72px,1fr)) 30px;position:relative;top:auto}.corner{position:sticky;left:0;z-index:5;background:#fff}.matrix-action-gutter{z-index:6;width:30px;border-left:1px solid var(--line-strong);background:#f7f8f7;box-shadow:-4px 0 7px #18201b0a}.project-head-row{grid-template-columns:280px repeat(var(--steps),minmax(72px,1fr)) 30px}.project-disclosure{width:30px;border-left-color:var(--line-strong);background:#f7f8f7;box-shadow:-4px 0 7px #18201b0a}.aggregate-bead:after{background:var(--center,#fff)}.opener-select,.view-days{height:30px;min-width:130px;border:1px solid var(--line-strong);border-radius:5px;background:#fff;padding:0 9px}@media(max-width:520px){.matrix-head,.project-head-row,.taskrow{grid-template-columns:220px repeat(var(--steps),minmax(66px,1fr)) 30px}}
.taskrow{grid-template-columns:280px repeat(var(--steps),minmax(72px,1fr)) 30px}.workspace:not(.plain){overflow-y:clip}
</style></head><body><div class="app">
<aside class="rail" aria-label="Primary navigation"><div class="brand">axi-factorio</div><nav class="nav">
<button class="nav-item active" data-page="overview">Overview</button><button class="nav-item" data-page="projects">Projects</button><button class="nav-item" data-page="runs">Runs</button><button class="nav-item" data-page="alerts">Alerts</button><button class="nav-item" data-page="settings">Settings</button>
</nav><div class="agent"><strong>Factorio</strong><span>Service online</span></div></aside>
<main class="main"><header class="topbar"><div class="identity"><strong>Factorio Dashboard</strong><span class="online">Online</span></div>
<label class="search"><input id="search" type="search" placeholder="Search projects or tasks…" aria-label="Search projects or tasks"></label>
<button class="refresh" id="refresh">Refresh</button></header>
<section class="content"><div class="toolbar"><strong id="page-title">All Projects</strong></div>
<div class="workspace" id="workspace"><div class="empty"><b>Loading workspace</b>Your projects will appear here.</div></div>
<div class="footer" id="footer"><div class="legend"><span><i class="key complete"></i>Completed</span><span><i class="key imported"></i>Imported</span><span><i class="key inventory"></i>Inventory</span><span><i class="key current"></i>Current</span><span><i class="key waiting"></i>Awaiting review / needs attention</span><span><i class="key"></i>Pending</span><span><i class="key failed"></i>Failed</span></div><span class="total" id="total"></span></div>
<div id="action-status" class="action-status" role="status"></div><div id="error" role="status"></div>
<section class="learning" id="learning" hidden aria-label="Task learning inspector"></section>
</section></main></div>
${workspaceOpenMenuMarkup()}
<script>
${viewerComponentScript}
const byId=id=>document.getElementById(id);let snapshot=null,learning=null,selectedAttemptId=null,blobPreview=null,promptPreview=null,currentPage='overview',menuTrigger=null,menuBlobId=null,overviewStructureKey='',showAllProjects=false;const collapsedProjects=new Set(),knownProjects=new Set();
async function load(){try{const response=await fetch('/api/view');if(!response.ok)throw new Error('Could not refresh the workspace.');const next=await response.json();collapseNewProjects(next.projects);snapshot=next;render();byId('error').innerHTML=''}catch(error){byId('error').innerHTML='<div class="error">'+escapeHtml(error.message)+'</div>'}}
function collapseNewProjects(projects){for(const project of projects){if(!knownProjects.has(project.id))collapsedProjects.add(project.id);knownProjects.add(project.id)}}
function render(){if(!snapshot)return;document.querySelectorAll('[data-page]').forEach(button=>button.classList.toggle('active',button.dataset.page===currentPage));byId('page-title').textContent=pageTitle();byId('search').hidden=!['overview','projects'].includes(currentPage);byId('footer').hidden=currentPage!=='overview';byId('workspace').classList.toggle('plain',currentPage!=='overview');if(currentPage==='overview')return renderOverview();if(currentPage==='projects')return renderProjects();if(currentPage==='runs')return renderRuns();if(currentPage==='alerts')return renderAlerts();renderSettings()}
function pageTitle(){return {overview:'All Projects',projects:'Projects',runs:'Runs',alerts:'Alerts',settings:'Settings'}[currentPage]}
function filteredProjects(){const query=byId('search').value.trim().toLowerCase();return snapshot.projects.map(project=>({...project,blobs:project.blobs.filter(blob=>matches(blob,project,query))})).filter(project=>project.blobs.length||(!query&&snapshot.projects.length)||project.name.toLowerCase().includes(query))}
function renderOverview(){const projects=filteredProjects(),days=snapshot.settings.activeProjectDays,sorted=sortProjects(projects,snapshot.settings.sortProjectsByProgress),active=sorted.filter(project=>projectHasActiveWork(project,new Date(),days)),inactive=sorted.filter(project=>!projectHasActiveWork(project,new Date(),days)),visible=showAllProjects?[...active,...inactive]:active,query=byId('search').value.trim(),key=overviewKey(visible)+'|fold:'+showAllProjects+'|inactive:'+inactive.map(project=>project.id).join(',');byId('total').textContent=snapshot.stats.tasks+' '+plural(snapshot.stats.tasks,'task')+' across '+snapshot.stats.projects+' '+plural(snapshot.stats.projects,'project');if(!projects.length){overviewStructureKey='';return void(byId('workspace').innerHTML='<div class="no-results">'+(query?'No projects or tasks match your search.':'No projects yet. Add a project and its work will appear here.')+'</div>')}if(key!==overviewStructureKey||!byId('workspace').querySelector('.matrix')){byId('workspace').innerHTML=matrix(active,showAllProjects?inactive:[],inactive.length);overviewStructureKey=key;return}patchOverview(visible)}
function renderProjects(){overviewStructureKey='';const projects=filteredProjects();byId('workspace').innerHTML='<div class="page-list">'+(projects.map(project=>'<article class="page-card"><div class="page-card-head"><strong>'+escapeHtml(project.name)+'</strong><span>'+project.blobs.length+' '+plural(project.blobs.length,'task')+'</span></div><p>Pipeline '+escapeHtml(project.resolvedPipeline||project.defaultPipeline)+(project.pipelineIssue?' · '+escapeHtml(project.pipelineIssue.summary):'')+'</p><p><code>'+escapeHtml(project.root)+'</code></p></article>').join('')||'<div class="empty"><b>No projects found</b>Try another search.</div>')+'</div>'}
function renderRuns(){overviewStructureKey='';byId('workspace').innerHTML=snapshot.executionOverviewHtml||'<div class="empty"><b>No runs yet</b>Execution history will appear here.</div>'}
function renderAlerts(){const alerts=[];for(const project of snapshot.projects){if(project.pipelineIssue)alerts.push({kind:'failure',title:project.name+' · Pipeline unavailable',detail:project.pipelineIssue.detail});for(const blob of project.blobs){if(blob.status==='failed')alerts.push({kind:'failure',title:blob.title+' · Failed',detail:'Current step: '+blob.stepId});else if(blob.status==='blocked'||blob.status==='waiting')alerts.push({kind:'attention',title:blob.title+' · '+statusLabel(blob.status),detail:project.name+' · '+blob.stepId})}}byId('workspace').innerHTML=alerts.length?'<div class="page-list">'+alerts.map(alert=>'<article class="page-card alert-card '+alert.kind+'"><div class="page-card-head"><strong>'+escapeHtml(alert.title)+'</strong></div><p>'+escapeHtml(alert.detail)+'</p></article>').join('')+'</div>':'<div class="empty"><b>No alerts</b>Failures and work needing attention will appear here.</div>'}
function renderSettings(){const enabled=snapshot.settings.debugMode,opener=snapshot.settings.opener,days=snapshot.settings.activeProjectDays,sort=snapshot.settings.sortProjectsByProgress;byId('workspace').innerHTML='<section class="page-list"><article class="page-card settings-card"><div class="setting-row"><div class="setting-copy"><strong>Default opener</strong><p>Choose the local app used by Open on a task.</p></div><select class="opener-select" id="opener" aria-label="Default opener"><option value="cursor" '+(opener.id==='cursor'?'selected':'')+'>Cursor</option></select></div></article><article class="page-card settings-card"><div class="setting-row"><div class="setting-copy"><strong>Active project window</strong><p>Show projects with meaningful task activity in the last number of days.</p></div><input class="view-days" id="active-project-days" type="number" min="1" max="365" value="'+days+'" aria-label="Active project window in days"></div><div class="setting-row" style="margin-top:14px"><div class="setting-copy"><strong>Sort projects by progress</strong><p>Show the furthest-progressed projects first.</p></div><label class="switch"><input id="sort-projects" type="checkbox" '+(sort?'checked':'')+' aria-label="Sort projects by progress"><span></span></label></div></article><article class="page-card settings-card"><div class="setting-row"><div class="setting-copy"><strong>Debug mode</strong><p>Pause automatic progression and expose manual Step, Play, and Stop controls for pipeline validation.</p></div><label class="switch"><input id="debug-mode" type="checkbox" '+(enabled?'checked':'')+' aria-label="Debug mode"><span></span></label></div>'+(enabled?'<div class="debug-notice">Debug mode is on. Continuous play is disabled; use Step to advance one transition at a time.</div>':'')+'</article></section>'}
function matches(blob,project,query){return !query||project.name.toLowerCase().includes(query)||blob.title.toLowerCase().includes(query)||blob.id.toLowerCase().includes(query)}
function matrix(active,inactive,inactiveCount){const steps=snapshot.steps,fold=inactiveCount?projectFold(inactiveCount):'',bands=[];let column=2;for(const group of snapshot.groups){bands.push('<div class="band" style="grid-column:'+column+' / span '+group.count+'">'+escapeHtml(group.label)+'</div>');column+=group.count}return '<div class="matrix" style="--steps:'+Math.max(steps.length,1)+'"><div class="matrix-head" style="--steps:'+Math.max(steps.length,1)+'"><div class="corner"></div><div class="matrix-action-gutter" style="grid-column:'+(steps.length+2)+'" aria-hidden="true"></div>'+bands.join('')+steps.map((step,index)=>'<div class="step" style="grid-column:'+(index+2)+'">'+escapeHtml(step.label)+'</div>').join('')+'</div>'+active.map(projectCard).join('')+fold+inactive.map(projectCard).join('')+'</div>'}
function projectFold(count){const action=showAllProjects?'Hide inactive projects':'Show all projects';return '<div class="project-fold-row"><button data-show-projects="'+(!showAllProjects)+'" aria-expanded="'+showAllProjects+'"><span aria-hidden="true">'+(showAllProjects?'⌃':'⌄')+'</span>'+action+'<small>'+count+'</small></button></div>'}
function projectCard(project){const collapsed=collapsedProjects.has(project.id);const issue=project.pipelineIssue?'<span class="pipeline-issue" title="'+escapeAttr(project.pipelineIssue.detail)+'">'+escapeHtml(project.pipelineIssue.summary)+'</span>':'';const rows=project.blobs.length?project.blobs.map(taskRow).join(''):'<div class="empty-project">'+(project.pipelineIssue?'This project is isolated until its pipeline path is restored.':'No tasks in this project.')+'</div>';const track=snapshot.steps.map((step,index)=>collapsed?aggregateCell(project,step,index):'<div class="project-head-track '+(index===0?'first ':'')+(index===snapshot.steps.length-1?'last':'')+'"></div>').join('');return '<section class="project '+(collapsed?'collapsed':'')+'" data-project="'+escapeHtml(project.id)+'"><div class="project-head-row" style="--steps:'+Math.max(snapshot.steps.length,1)+'"><div class="project-identity"><span>'+escapeHtml(project.name)+'</span>'+issue+'</div>'+track+disclosureMarkup(project.id,project.name,collapsed)+'</div><div class="taskrows">'+rows+'</div></section>'}
function taskRow(blob){const cells=snapshot.steps.map((step,index)=>beadCell(blob,step,index)).join(''),label=statusLabel(blob.status),viewKey=blobViewKey(blob);return '<div class="taskrow" data-blob-row="'+escapeAttr(blob.id)+'" data-view-key="'+escapeAttr(viewKey)+'" style="--steps:'+Math.max(snapshot.steps.length,1)+'"><div class="task-title" title="'+escapeAttr(blob.title)+'">'+blobNameMenuTriggerMarkup(blob.id,blob.title)+(label?'<small class="task-status '+blob.status+'">'+label+'</small>':'')+runControls(blob)+'</div>'+cells+'<div class="task-action-gutter" aria-hidden="true"></div></div>'}
function runControls(blob){if(!snapshot.settings.debugMode)return '';const debug=controlButton(blob,'step',stepIcon())+controlButton(blob,'play',playIcon())+controlButton(blob,'stop',stopIcon());return '<span class="run-controls" aria-label="Debug task actions">'+debug+'</span>'}
function controlButton(blob,action,icon){const control=blob.execution[action];const mode=action==='play'||action==='step';const selected=mode&&blob.execution.mode===(action==='play'?'continuous':'step');const active=selected||(action==='stop'&&blob.execution.requested);const label=action==='play'?'Play continuously':action==='step'?'Run one transition':'Stop';const explanation=escapeHtml(control.explanation);return '<span class="control-tip" data-tip="'+explanation+'" '+(control.enabled?'':'tabindex="0" aria-label="'+explanation+'"')+'><button class="run-control '+action+(mode?' mode':'')+(active?' active':'')+'" data-action="'+action+'" data-blob="'+escapeHtml(blob.id)+'" aria-label="'+label+'" aria-pressed="'+active+'" title="'+explanation+'" '+(control.enabled?'':'disabled')+'>'+icon+'</button></span>'}
function playIcon(){return '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1.3v9.4L10 6z"/></svg>'}function stepIcon(){return '<svg viewBox="0 0 14 12" aria-hidden="true"><path d="M1 1.3v9.4L9 6zM11 1h2v10h-2z"/></svg>'}function stopIcon(){return '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2h8v8H2z"/></svg>'}
function beadCell(blob,step,index){const known=blob.steps.some(candidate=>candidate.id===step.id);const done=blob.stepId==='complete'||blob.completedStepIds.includes(step.id);const current=blob.stepId===step.id;const imported=done&&blob.importedStepIds.includes(step.id);const classes=['bead',done?'done':'',imported?'imported':'',current?'current':'',current?blob.status:'',!known?'unavailable':''].filter(Boolean).join(' ');const tooltip=beadTooltip(blob,step,done,current,imported,known);return '<div class="track-cell '+(index===0?'first ':'')+(index===snapshot.steps.length-1?'last':'')+'"><i class="'+classes+'" title="'+escapeAttr(tooltip)+'" aria-label="'+escapeAttr(tooltip)+'"></i></div>'}
function beadTooltip(blob,step,done,current,imported,known){if(!known)return step.label+' is not in this task pipeline.';if(current&&blob.status==='held')return 'Inventory — held before its first run.';if(current)return step.label+' — '+(statusLabel(blob.status)||'current');if(done)return step.label+' — '+(imported?'imported completion':'completed');return step.label+' — pending'}
function aggregateCell(project,step,index){const data=aggregateModel(project,step),key=project.id+'::'+step.id;return '<div class="track-cell '+(index===0?'first ':'')+(index===snapshot.steps.length-1?'last':'')+'"><i class="aggregate-bead '+(data.total?'':'unavailable')+'" data-aggregate-key="'+escapeAttr(key)+'" data-aggregate-state="'+escapeAttr(data.signature)+'" style="--composition:'+escapeAttr(data.composition)+';--center:'+escapeAttr(data.center)+'" title="'+escapeAttr(data.label)+'" aria-label="'+escapeAttr(data.label)+'"></i></div>'}
function aggregateModel(project,step){const tasks=project.blobs.filter(blob=>blob.steps.some(candidate=>candidate.id===step.id)).slice().sort((a,b)=>a.id.localeCompare(b.id)),counts={completed:0,running:0,attention:0,failed:0,unfinished:0};for(const blob of tasks)counts[aggregateCategory(blob,step)]++;const total=tasks.length,composition=total?aggregateProgressGradient(counts.completed,total):'var(--neutral-soft)',center=counts.failed?'var(--danger)':counts.attention?'var(--attention)':counts.running?'var(--ink)':'#fff',label=total?step.label+' — '+total+' tasks: '+counts.completed+' completed, '+counts.running+' running, '+counts.attention+' need attention, '+counts.failed+' failed, '+counts.unfinished+' unfinished or inventory':step.label+' — 0 tasks';return {total,composition,center,label,signature:[composition,center,label].join('|')}}
function aggregateCategory(blob,step){if(blob.stepId==='complete'||blob.completedStepIds.includes(step.id))return 'completed';if(blob.stepId!==step.id)return 'unfinished';if(blob.status==='failed')return 'failed';if(blob.status==='waiting'||blob.status==='blocked')return 'attention';if(blob.status==='running'||blob.status==='queued')return 'running';return 'unfinished'}
function overviewKey(projects){return JSON.stringify({steps:snapshot.steps.map(step=>step.id),debug:snapshot.settings.debugMode,projects:projects.map(project=>[project.id,project.name,project.pipelineIssue?.summary||'',collapsedProjects.has(project.id),project.blobs.map(blob=>[blob.id,blob.title])])})}
function blobViewKey(blob){return JSON.stringify([blob.title,blob.status,blob.stepId,blob.completedStepIds,blob.importedStepIds,snapshot.settings.debugMode,blob.execution])}
function patchOverview(projects){for(const project of projects){for(const step of snapshot.steps){const marker=byId('workspace').querySelector('[data-aggregate-key="'+CSS.escape(project.id+'::'+step.id)+'"]');if(marker)updateAggregateMarker(marker,aggregateModel(project,step))}for(const blob of project.blobs){const row=byId('workspace').querySelector('[data-blob-row="'+CSS.escape(blob.id)+'"]');if(row&&row.dataset.viewKey!==blobViewKey(blob))row.outerHTML=taskRow(blob)}}}
function statusLabel(status){return {queued:'Queued',held:'',running:'Running',waiting:'Awaiting review',blocked:'Needs attention',failed:'Failed'}[status]||''}
function plural(count,word){return count===1?word:word+'s'}function escapeHtml(value){const node=document.createElement('span');node.textContent=String(value);return node.innerHTML}function escapeAttr(value){return escapeHtml(value).replaceAll('"','&quot;')}
async function control(action,blobId){try{const before=learning?.blob.id===blobId?learning.attempts.length:null;const response=await fetch('/api/blobs/'+encodeURIComponent(blobId)+'/'+action,{method:'POST'});const result=await response.json();if(!response.ok)throw new Error(result.error||'The request failed.');if(action==='open'){showActionStatus('Opened '+result.root+'.','success');return await load()}await load();if(before!==null)await waitForLearning(blobId,before)}catch(error){if(action==='open')showActionStatus(error.message,'failure');else showLearningError(error);await load()}}
function showActionStatus(message,state){const target=byId('action-status');target.className='action-status '+state;target.textContent=message}
async function waitForLearning(blobId,before){for(let index=0;index<24;index+=1){await openLearning(blobId);const latest=learning.attempts.at(-1);if((learning.attempts.length>before||!learning.blob.runRequested)&&latest?.receipt.status!=='running'){if(learning.attempts.length>before){selectedAttemptId=latest.receipt.id;renderLearning()}await load();return}await new Promise(resolve=>setTimeout(resolve,100))}}
async function openLearning(blobId){const response=await fetch('/api/blobs/'+encodeURIComponent(blobId)+'/learning');const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not inspect this task.');learning=result;if(!selectedAttemptId||!learning.attempts.some(item=>item.receipt.id===selectedAttemptId))selectedAttemptId=learning.attempts.at(-1)?.receipt.id||null;blobPreview=null;promptPreview=null;renderLearning()}
function renderLearning(){const root=byId('learning');if(!learning){root.hidden=true;return}root.hidden=false;const selected=learning.attempts.find(item=>item.receipt.id===selectedAttemptId)||learning.attempts.at(-1);root.innerHTML='<div class="learning-head"><strong>'+escapeHtml(learning.blob.title)+'</strong><small>'+escapeHtml(learning.blob.id)+' · r'+learning.revision.revision+' · '+escapeHtml(learning.blob.state)+'</small><button data-learning-action="close">Close</button></div><div class="learning-actions"><button class="primary" data-learning-action="step">Step once</button><button data-learning-action="rewind" '+(selected?'':'disabled')+'>Rewind + rerun selected step</button><button data-learning-action="retry">Retry</button></div><div class="learning-grid"><div class="attempt-list">'+attemptButtons()+'</div><div class="attempt-detail">'+attemptDetail(selected)+'</div></div>'+compareAttempts()+editors()+humanEditor()+'<div class="learning-error" id="learning-error"></div>'}
function attemptButtons(){if(!learning.attempts.length)return '<div class="empty">No attempts yet. Run Step once.</div>';return learning.attempts.slice().reverse().map(item=>'<button class="attempt-button '+(item.receipt.id===selectedAttemptId?'selected':'')+'" data-attempt="'+escapeAttr(item.receipt.id)+'"><b>#'+item.receipt.attempt+' · '+escapeHtml(item.receipt.stepId)+' · '+escapeHtml(item.receipt.status)+'</b><small>'+(item.evidence?'blob r'+item.evidence.blobRevision.revision+' · '+short(item.evidence.definition.contentHash):'legacy evidence')+' · '+(item.receipt.invalidatedAt?'superseded':'current')+'</small></button>').join('')}
function attemptDetail(item){if(!item)return '<div class="empty">Step once to create immutable attempt evidence.</div>';const evidence=item.evidence;const receipt=item.receipt;const events=item.events.map(event=>'#'+event.id+' '+event.name+' '+JSON.stringify(event.attributes)).join('\\n');return '<div class="evidence-grid"><div class="evidence-card wide"><small>Blob input snapshot</small><pre>'+(evidence?'r'+evidence.blobRevision.revision+' · '+short(evidence.blobRevision.contentHash)+'\\n'+escapeHtml(evidence.blobRevision.title)+'\\n'+escapeHtml(evidence.blobRevision.body):'Unavailable for legacy receipt')+'</pre></div><div class="evidence-card"><small>Harness / model</small><pre>'+escapeHtml(evidence?.harness||receipt.adapter)+' / '+escapeHtml(evidence?.model||'not reported')+'\\nrun '+escapeHtml(receipt.externalRunId||'not reported')+'</pre></div><div class="evidence-card"><small>Decision / metrics</small><pre>'+escapeHtml(receipt.status)+'\\n'+escapeHtml(receipt.reason||receipt.error||'')+'\\n'+metricText(item)+'</pre></div><div class="evidence-card wide"><small>Entry Markdown · Git SHA / content hash</small><pre>'+(evidence?short(evidence.definition.gitSha)+' / '+short(evidence.definition.contentHash)+'\\n'+escapeHtml(evidence.definition.entry):'Definition '+short(receipt.definitionGitSha)+' / '+short(receipt.definitionHash))+'</pre></div><div class="evidence-card wide"><small>Exit Markdown</small><pre>'+(evidence?escapeHtml(evidence.definition.exit):'Unavailable for legacy receipt')+'</pre></div><div class="evidence-card wide"><small>Input → output artifacts</small><pre>'+escapeHtml(receipt.inputArtifacts.join('\\n')||'none')+'\\n→\\n'+escapeHtml(receipt.outputArtifacts.join('\\n')||'none')+'</pre></div><div class="evidence-card wide"><small>Append-only harness events</small><pre>'+escapeHtml(events||'none')+'</pre></div></div>'}
function compareAttempts(){if(learning.attempts.length<2)return '';const pair=learning.attempts.slice(-2);return '<section class="compare">'+pair.map(item=>'<div><b>#'+item.receipt.attempt+' · '+escapeHtml(item.receipt.status)+(item.receipt.invalidatedAt?' · superseded':'')+'</b><p>Blob '+(item.evidence?'r'+item.evidence.blobRevision.revision+' '+short(item.evidence.blobRevision.contentHash):'legacy')+'<br>Prompt '+short(item.evidence?.definition.contentHash||item.receipt.definitionHash)+'<br>'+metricText(item)+'</p></div>').join('')+'</section>'}
function editors(){const step=selectedStep();return '<section class="editors"><div class="editor"><b>Edit durable blob revision</b><input id="blob-title" value="'+escapeAttr(learning.revision.title)+'" aria-label="Blob title"><textarea id="blob-body" aria-label="Blob content">'+escapeHtml(learning.revision.body)+'</textarea><div class="editor-actions"><button data-learning-action="preview-blob">Preview diff</button><button data-learning-action="save-blob" '+(blobPreview?.valid?'':'disabled')+'>Save revision</button><button data-learning-action="cancel-edit">Cancel</button></div>'+previewHtml(blobPreview)+'</div><div class="editor"><b>Edit actual pipeline Markdown</b><select id="prompt-kind" aria-label="Prompt kind"><option value="entry">Entry</option><option value="exit">Exit</option></select><textarea id="prompt-content" aria-label="Pipeline Markdown">'+escapeHtml(step?.entry||'')+'</textarea><input type="hidden" id="prompt-step" value="'+escapeAttr(step?.id||learning.blob.state)+'"><div class="editor-actions"><button data-learning-action="preview-prompt">Preview diff</button><button data-learning-action="save-prompt" '+(promptPreview?.valid?'':'disabled')+'>Save Markdown</button><button data-learning-action="cancel-edit">Cancel</button></div>'+previewHtml(promptPreview)+'</div></section>'}
function humanEditor(){return '<div class="human-actions"><input id="human-text" placeholder="Human feedback or approval evidence"><button data-learning-action="feedback">Reject with feedback</button><button data-learning-action="approve">Approve with exact-head evidence</button><button data-learning-action="reset-endpoint">Reset local endpoint</button></div>'}
function selectedStep(){const attempt=learning.attempts.find(item=>item.receipt.id===selectedAttemptId)||learning.attempts.at(-1);return learning.steps.find(item=>item.id===(attempt?.receipt.stepId||learning.blob.state))||learning.steps[0]}
function previewHtml(preview){if(!preview)return '';const lines=preview.diff||preview.bodyDiff||[];return (preview.error?'<div class="validation">'+escapeHtml(preview.error)+'</div>':'')+'<div class="diff">'+lines.map(line=>'<div class="'+line.kind+'">'+(line.kind==='add'?'+ ':line.kind==='remove'?'- ':'  ')+escapeHtml(line.text)+'</div>').join('')+'</div>'}
function metricText(item){return (item.elapsedMs===null?'time not reported':item.elapsedMs+' ms')+' · '+(item.inputTokens===null?'tokens not reported':item.inputTokens+' input / '+item.outputTokens+' output tokens')}
function short(value){return value?String(value).slice(0,10)+'…':'not reported'}
async function learningPost(action,payload={}){const response=await fetch('/api/blobs/'+encodeURIComponent(learning.blob.id)+'/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(result.error||'The learning action failed.');return result}
async function learningAction(action){try{if(action==='close'){learning=null;return renderLearning()}if(action==='step'){await control('step',learning.blob.id);return}if(action==='rewind'){const selected=learning.attempts.find(item=>item.receipt.id===selectedAttemptId);const before=learning.attempts.length;await learningPost('rewind-step',{stepId:selected.receipt.stepId});selectedAttemptId=null;await waitForLearning(learning.blob.id,before);return}if(action==='retry'){const before=learning.attempts.length;await learningPost('retry');await waitForLearning(learning.blob.id,before);return}if(action==='preview-blob'){blobPreview=await learningPost('blob/preview',{title:byId('blob-title').value,body:byId('blob-body').value});return renderLearning()}if(action==='save-blob'){await learningPost('blob/save',{title:blobPreview.after.title,body:blobPreview.after.body,expectedRevision:blobPreview.expectedRevision});await openLearning(learning.blob.id);return}if(action==='preview-prompt'){promptPreview=await learningPost('prompt/preview',{stepId:byId('prompt-step').value,kind:byId('prompt-kind').value,content:byId('prompt-content').value});return renderLearning()}if(action==='save-prompt'){await learningPost('prompt/save',{stepId:promptPreview.stepId,kind:promptPreview.kind,content:promptPreview.after,expectedContentHash:promptPreview.expectedContentHash});await openLearning(learning.blob.id);return}if(action==='cancel-edit'){blobPreview=null;promptPreview=null;return renderLearning()}if(action==='reset-endpoint'){await learningPost('reset-endpoint',{reason:'Local endpoint reset from Viewer.'});await openLearning(learning.blob.id);return}if(action==='feedback'){const before=learning.attempts.length;await learningPost('feedback',{text:byId('human-text').value,evidence:['viewer:human-feedback']});await waitForLearning(learning.blob.id,before);return}if(action==='approve'){const before=learning.attempts.length;await learningPost('approve',{text:byId('human-text').value,evidence:['viewer:exact-head-approval']});await waitForLearning(learning.blob.id,before)}}catch(error){showLearningError(error)}}
function showLearningError(error){const target=byId('learning-error')||byId('error');if(target)target.innerHTML='<div class="error">'+escapeHtml(error.message)+'</div>'}
byId('refresh').onclick=async()=>{closeBlobMenu(false);await load();if(learning)await openLearning(learning.blob.id)};byId('search').oninput=render;document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!byId('blob-menu').hidden){event.preventDefault();return closeBlobMenu(true)}if(event.key==='/'&&document.activeElement!==byId('search')){event.preventDefault();byId('search').focus()}});
document.querySelector('.nav').onclick=event=>{const target=event.target.closest('[data-page]');if(!target)return;currentPage=target.dataset.page;learning=null;renderLearning();render()};
byId('workspace').onclick=event=>{const menu=event.target.closest('[data-blob-menu]');if(menu){event.stopPropagation();return openBlobMenu(menu)}const action=event.target.closest('[data-action]');if(action){action.disabled=true;return void control(action.dataset.action,action.dataset.blob)}const fold=event.target.closest('[data-show-projects]');if(fold){showAllProjects=fold.dataset.showProjects==='true';overviewStructureKey='';return renderOverview()}const disclosure=event.target.closest('[data-project-toggle]');if(!disclosure)return;const id=disclosure.dataset.projectToggle;if(collapsedProjects.has(id))collapsedProjects.delete(id);else collapsedProjects.add(id);renderOverview()};
byId('workspace').onchange=event=>{if(event.target.id==='debug-mode')return void updateDebugMode(event.target.checked);if(event.target.id==='opener')return void updateOpener(event.target.value);if(event.target.id==='active-project-days'||event.target.id==='sort-projects')return void updateViewSettings()};
byId('blob-menu').onclick=event=>{const item=event.target.closest('[data-menu-action]');if(!item||item.disabled)return;const blobId=menuBlobId;closeBlobMenu(false);void control(item.dataset.menuAction,blobId)};
document.addEventListener('click',event=>{if(byId('blob-menu').hidden||event.target.closest('#blob-menu')||event.target.closest('[data-blob-menu]'))return;closeBlobMenu(true)});
function openBlobMenu(trigger){const blob=snapshot.projects.flatMap(project=>project.blobs).find(item=>item.id===trigger.dataset.blobMenu);if(!blob)return;closeBlobMenu(false);menuTrigger=trigger;menuBlobId=blob.id;trigger.setAttribute('aria-expanded','true');const menu=byId('blob-menu');menu.innerHTML='<button role="menuitem" data-menu-action="open" '+(blob.open.enabled?'':'disabled')+'>Open</button>'+(blob.open.enabled?'':'<small>'+escapeHtml(blob.open.explanation)+'</small>');menu.hidden=false;const box=trigger.getBoundingClientRect(),menuBox=menu.getBoundingClientRect(),left=Math.max(8,Math.min(box.left,innerWidth-menuBox.width-8));const below=box.bottom+5,top=below+menuBox.height<=innerHeight-8?below:Math.max(8,box.top-menuBox.height-5);menu.style.left=left+'px';menu.style.top=top+'px';menu.querySelector('[role="menuitem"]').focus()}
function closeBlobMenu(returnFocus){const trigger=menuTrigger,blobId=menuBlobId,menu=byId('blob-menu');menu.hidden=true;menu.innerHTML='';if(trigger)trigger.setAttribute('aria-expanded','false');menuTrigger=null;menuBlobId=null;if(returnFocus)queueMicrotask(()=>{const target=trigger?.isConnected?trigger:document.querySelector('[data-blob-menu="'+CSS.escape(blobId||'')+'"]');target?.focus({preventScroll:true})})}
async function updateDebugMode(enabled){try{const response=await fetch('/api/settings/debug-mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not update Debug mode.');await load();showActionStatus(enabled?'Debug mode enabled. Automatic progression is paused.':'Debug mode disabled.','success')}catch(error){showActionStatus(error.message,'failure');await load()}}
async function updateOpener(opener){try{const response=await fetch('/api/settings/opener',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({opener})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not update the opener.');await load();showActionStatus('Default opener set to '+result.settings.opener.label+'.','success')}catch(error){showActionStatus(error.message,'failure');await load()}}
async function updateViewSettings(){try{const activeProjectDays=Number(byId('active-project-days').value),sortProjectsByProgress=byId('sort-projects').checked,response=await fetch('/api/settings/view',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({activeProjectDays,sortProjectsByProgress})}),result=await response.json();if(!response.ok)throw new Error(result.error||'Could not update View settings.');await load();showActionStatus('View settings saved.','success')}catch(error){showActionStatus(error.message,'failure');await load()}}
byId('learning').onclick=event=>{const attempt=event.target.closest('[data-attempt]');if(attempt){selectedAttemptId=attempt.dataset.attempt;blobPreview=null;promptPreview=null;return renderLearning()}const action=event.target.closest('[data-learning-action]');if(action)return void learningAction(action.dataset.learningAction)};
byId('learning').onchange=event=>{if(event.target.id!=='prompt-kind')return;const step=selectedStep();byId('prompt-content').value=event.target.value==='entry'?step.entry:step.exit;promptPreview=null};
load();setInterval(load,2000);
</script></body></html>`;

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) startViewer();

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AttemptEvidence,
  Blob,
  ExecutionEvent,
  ExecutionMode,
  HumanInput,
  Project,
  Receipt,
  StepDefinition,
} from "./Types.ts";
import type { PromptKind } from "./Learning.ts";
import type { CursorActionState } from "./CursorAction.ts";
import { createServer } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FactorioDatabase } from "./Database.ts";
import { log } from "./Logger.ts";
import { discoverPipeline, requireStep, snapshotDefinition } from "./Pipeline.ts";
import { previewBlobEdit, previewPromptEdit, savePromptEdit } from "./Learning.ts";
import { BlobExecutionError, ConveyorStore } from "./Store.ts";
import { CursorWorkspaceLauncher } from "./CursorAction.ts";
import { viewerComponentScript, workspaceOpenMenuMarkup } from "./ViewerComponents.ts";
import {
  executionOverviewMarkup,
  listExecutionSessions,
  listExecutionStatusItems,
  liveExecutionStyles,
} from "./LiveExecutions.ts";
