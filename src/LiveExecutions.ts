export type ExecutionSession = {
  projectId: string;
  projectName: string;
  blobId: string;
  blobTitle: string;
  stepId: string;
  attempt: number;
  receiptId: string;
  harness: string;
  model: string | null;
  reasoningEffort: string | null;
  sessionId: string | null;
  status: ReceiptStatus;
  queuedAt: string;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  lastProgressAt: string;
  currentOperation: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  terminalReason: string | null;
  executionWorkspace: string;
  stale: boolean;
};

export type LiveExecution = ExecutionSession & { status: "running" };

export type ExecutionStatusItem = {
  projectName: string;
  blobId: string;
  blobTitle: string;
  stepId: string;
  status: "queued" | "waiting";
  queuedAt?: string;
  attempt?: number;
};

export function listExecutionSessions(
  store: ConveyorStore,
  now = new Date(),
): ExecutionSession[] {
  const blobs = new Map(store.listBlobs().map((blob) => [blob.id, blob]));
  const projects = new Map(store.listProjects().map((project) => [project.id, project]));
  return store.listReceipts()
    .filter((receipt) => receipt.executionKind === "automated" && !receipt.invalidatedAt)
    .map((receipt) => executionSession(receipt, blobs, projects, now))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function listLiveExecutions(store: ConveyorStore, now = new Date()): LiveExecution[] {
  return listExecutionSessions(store, now)
    .filter((execution): execution is LiveExecution => execution.status === "running");
}

export function listExecutionStatusItems(store: ConveyorStore): ExecutionStatusItem[] {
  const projects = new Map(store.listProjects().map((project) => [project.id, project]));
  const receipts = store.listReceipts();
  return store.listBlobs().flatMap((blob) => {
    const latest = receipts.filter((receipt) =>
      receipt.blobId === blob.id && !receipt.invalidatedAt).at(-1);
    const base = {
      projectName: projects.get(blob.projectId)?.name ?? titleCase(blob.projectId),
      blobId: blob.id,
      blobTitle: blob.title,
      stepId: blob.state,
      attempt: latest?.attempt ? latest.attempt + 1 : 1,
    };
    if (blob.runRequested && latest?.status !== "running") {
      return [{ ...base, status: "queued" as const, queuedAt: blob.updatedAt }];
    }
    if (blob.paused && blob.humanGateStepId === blob.state) {
      return [{ ...base, status: "waiting" as const }];
    }
    return [];
  });
}

export function liveExecutionMarkup(executions: ExecutionSession[], showEmpty = false): string {
  if (!executions.length && !showEmpty) return "";
  const body = executions.length
    ? executions.map(executionCard).join("")
    : '<div class="live-empty">No execution receipts yet.</div>';
  const running = executions.filter((execution) => execution.status === "running").length;
  return '<section class="live-panel" aria-label="Execution sessions">'
    + '<div class="live-panel-head"><strong>Execution sessions</strong><span>'
    + running + " running · " + executions.length + " shown</span></div>"
    + '<div class="live-list">' + body + "</div></section>";
}

export function executionOverviewMarkup(
  executions: ExecutionSession[],
  statusItems: ExecutionStatusItem[],
): string {
  return liveExecutionMarkup(executions, true) + statusItemsMarkup(statusItems);
}

export const liveExecutionStyles = String.raw`
.live-panel,.execution-status-panel{margin-bottom:12px;border:1px solid var(--line-strong);background:#fff}.live-panel-head{height:40px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--line);font-size:12px}.live-panel-head span{margin-left:auto;color:var(--muted);font-size:10px}.live-list{display:grid}.live-card{display:grid;grid-template-columns:minmax(210px,1fr) minmax(190px,.8fr) minmax(300px,1.25fr);gap:16px;align-items:start;padding:14px 12px;border-bottom:1px solid var(--line)}.live-card:last-child{border-bottom:0}.live-identity,.live-cell{min-width:0}.live-identity strong,.live-cell b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.live-identity small,.live-cell small{display:block;color:var(--muted);font-size:10px}.live-status{display:inline-flex;align-items:center;gap:7px;color:var(--ink);font-size:11px;font-weight:750}.live-status:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ink)}.live-status.running:before{box-shadow:0 0 0 3px var(--neutral-soft);animation:live-pulse 1.5s ease-in-out infinite}.live-status.retry,.live-status.blocked,.live-status.interrupted{color:var(--attention)}.live-status.retry:before,.live-status.blocked:before,.live-status.interrupted:before{background:var(--attention)}.live-status.failed{color:var(--danger)}.live-status.failed:before{background:var(--danger)}.live-session{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.live-empty{padding:20px 12px;color:var(--muted);font-size:11px}.live-time{display:grid;grid-template-columns:auto 1fr;gap:3px 8px}.live-time small{text-align:right}.live-time b{font-weight:550}.live-operation{margin-top:7px;padding:6px 8px;background:var(--neutral-soft);font-size:10px}.live-health{margin-top:5px;font-size:10px;font-weight:750}.live-health.stale{padding:6px 8px;background:var(--attention-soft);color:var(--attention)}.live-metrics{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.live-metric{padding:6px 8px;background:var(--neutral-soft)}.live-metric small{display:block;font-size:9px;color:var(--muted)}.live-metric b{display:block;font-size:11px}.execution-status-list{display:grid;grid-template-columns:1fr 1fr}.execution-status-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:11px 12px}.execution-status-item+.execution-status-item{border-left:1px solid var(--line)}.execution-status-item strong{display:block;font-size:12px}.execution-status-item small{display:block;color:var(--muted);font-size:10px}.execution-state{align-self:center;border:1px solid var(--line-strong);border-radius:999px;padding:4px 8px;font-size:10px;font-weight:700}.execution-state.waiting{color:var(--attention);border-color:#e3bd8d;background:var(--attention-soft)}@keyframes live-pulse{50%{opacity:.35}}@media(prefers-reduced-motion:reduce){.live-status.running:before{animation:none}}@media(max-width:900px){.live-card{grid-template-columns:1fr 1fr}.live-identity{grid-column:1/-1}.live-card>.live-cell:last-of-type{grid-column:1/-1}.execution-status-list{grid-template-columns:1fr}.execution-status-item+.execution-status-item{border-left:0;border-top:1px solid var(--line)}}@media(max-width:560px){.live-card{grid-template-columns:1fr}.live-identity,.live-card>.live-cell:last-of-type,.live-metrics{grid-column:auto}.live-metrics{grid-template-columns:1fr 1fr}}`;

function executionSession(
  receipt: Receipt,
  blobs: Map<string, Blob>,
  projects: Map<string, Project>,
  now: Date,
): ExecutionSession {
  const blob = blobs.get(receipt.blobId);
  if (!blob) throw new Error(`Receipt ${receipt.id} has no blob.`);
  const project = projects.get(blob.projectId);
  const finished = receipt.finishedAt ? new Date(receipt.finishedAt) : now;
  const elapsedMs = Math.max(0, finished.valueOf() - new Date(receipt.startedAt).valueOf());
  const stale = receipt.status === "running"
    && now.valueOf() - new Date(receipt.lastProgressAt).valueOf() >= staleAfterMs;
  return {
    projectId: blob.projectId,
    projectName: project?.name ?? titleCase(blob.projectId),
    blobId: blob.id,
    blobTitle: blob.title,
    stepId: receipt.stepId,
    attempt: receipt.attempt,
    receiptId: receipt.id,
    harness: receipt.adapter,
    model: receipt.model,
    reasoningEffort: receipt.reasoningEffort,
    sessionId: receipt.externalRunId,
    status: receipt.status,
    queuedAt: receipt.queuedAt,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    elapsedMs,
    lastProgressAt: receipt.lastProgressAt,
    currentOperation: receipt.currentOperation,
    inputTokens: receipt.inputTokens,
    cachedInputTokens: receipt.cachedInputTokens,
    outputTokens: receipt.outputTokens,
    totalTokens: receipt.totalTokens,
    terminalReason: receipt.error ?? receipt.reason,
    executionWorkspace: blob.executionWorkspaceRoot,
    stale,
  };
}

function executionCard(execution: ExecutionSession): string {
  const terminal = execution.status === "running"
    ? healthText(execution)
    : escapeHtml(execution.terminalReason ?? terminalFallback(execution.status));
  return '<article class="live-card">'
    + identityMarkup(execution)
    + '<div class="live-cell"><span class="live-status ' + execution.status + '">'
    + escapeHtml(statusLabel(execution.status)) + "</span><small>"
    + escapeHtml(execution.stepId) + " · attempt #" + execution.attempt + "</small>"
    + '<small>Harness session</small><b class="live-session" title="'
    + escapeAttribute(execution.sessionId ?? "Not reported") + '">'
    + escapeHtml(execution.sessionId ?? "Not reported") + "</b><small>"
    + escapeHtml(execution.harness) + " · " + escapeHtml(modelText(execution)) + "</small></div>"
    + '<div class="live-cell"><div class="live-time">' + timelineMarkup(execution)
    + '</div><div class="live-operation">' + escapeHtml(operationText(execution)) + "</div>"
    + '<div class="live-health ' + (execution.stale ? "stale" : "") + '">' + terminal + "</div></div>"
    + metricsMarkup(execution) + "</article>";
}

function identityMarkup(execution: ExecutionSession): string {
  return '<div class="live-identity"><small>' + escapeHtml(execution.projectName) + "</small><strong>"
    + escapeHtml(execution.blobTitle) + '</strong><small class="live-session">'
    + escapeHtml(execution.blobId) + " · " + escapeHtml(shortId(execution.receiptId))
    + '</small><small title="' + escapeAttribute(execution.executionWorkspace)
    + '">Agent working directory · ' + escapeHtml(execution.executionWorkspace) + "</small></div>";
}

function timelineMarkup(execution: ExecutionSession): string {
  return '<small>Queued</small><b>' + escapeHtml(displayTime(execution.queuedAt))
    + '</b><small>Started</small><b>' + escapeHtml(displayTime(execution.startedAt))
    + '</b><small>Progress</small><b>' + escapeHtml(displayTime(execution.lastProgressAt))
    + '</b><small>Finished</small><b>' + escapeHtml(
      execution.finishedAt ? displayTime(execution.finishedAt) : "—",
    ) + '</b><small>Elapsed</small><b>' + escapeHtml(duration(execution.elapsedMs)) + "</b>";
}

function metricsMarkup(execution: ExecutionSession): string {
  return '<div class="live-metrics">'
    + metricMarkup("Input", execution.inputTokens)
    + metricMarkup("Cached", execution.cachedInputTokens)
    + metricMarkup("Output", execution.outputTokens)
    + metricMarkup("Total", execution.totalTokens)
    + "</div>";
}

function metricMarkup(label: string, value: number | null): string {
  return '<div class="live-metric"><small>' + label + '</small><b>'
    + (value === null ? "Unknown" : value.toLocaleString("en-US")) + "</b></div>";
}

function statusItemsMarkup(items: ExecutionStatusItem[]): string {
  const cards = items.map((item) => '<article class="execution-status-item"><div><small>'
    + escapeHtml(item.projectName) + "</small><strong>" + escapeHtml(item.blobTitle)
    + '</strong><small class="live-session">' + escapeHtml(item.blobId) + " · "
    + escapeHtml(item.stepId) + (item.attempt ? ` · attempt #${item.attempt}` : "")
    + '</small></div><span class="execution-state ' + item.status + '">'
    + (item.status === "queued" ? "Queued" : "Awaiting review")
    + "</span></article>").join("");
  return '<section class="execution-status-panel" aria-label="Queued and awaiting review">'
    + '<div class="live-panel-head"><strong>Not running</strong><span>clearly separate states</span></div>'
    + '<div class="execution-status-list">' + cards + "</div></section>";
}

function healthText(execution: ExecutionSession): string {
  return execution.stale
    ? "No recent progress for 5m or more — check session"
    : "Healthy · receiving progress";
}

function operationText(execution: ExecutionSession): string {
  if (execution.status !== "running") return execution.currentOperation ?? "Execution finished";
  return execution.currentOperation ?? "Running agent harness";
}

function modelText(execution: ExecutionSession): string {
  const model = execution.model ?? "model unknown";
  return execution.reasoningEffort ? `${model} · ${execution.reasoningEffort}` : `${model} · reasoning unknown`;
}

function terminalFallback(status: ReceiptStatus): string {
  if (status === "advance") return "Completed successfully";
  if (status === "retry") return "Finished; eligible for retry";
  if (status === "blocked") return "Awaiting required input";
  if (status === "failed") return "Failed; retry required";
  if (status === "interrupted") return "Interrupted; retry required";
  return "Execution in progress";
}

function statusLabel(status: ReceiptStatus): string {
  return status === "advance" ? "Advanced" : titleCase(status);
}

function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function titleCase(value: string): string {
  return value.replace(/[._-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const staleAfterMs = 5 * 60_000;

import type { Blob, Project, Receipt, ReceiptStatus } from "./Types.ts";
import { ConveyorStore } from "./Store.ts";
