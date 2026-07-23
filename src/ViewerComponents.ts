export function blobNameMenuTriggerMarkup(blobId: string, title: string): string {
  return `<button class="task-name-button" data-blob-menu="${escapeAttribute(blobId)}"
    aria-haspopup="menu" aria-expanded="false">${escapeHtml(title)}</button>`;
}

export function workspaceOpenMenuMarkup(): string {
  return `<div class="blob-menu" id="blob-menu" role="menu" aria-label="Task actions" hidden></div>`;
}

export function disclosureMarkup(projectId: string, name: string, collapsed: boolean): string {
  const action = collapsed ? "Expand" : "Collapse";
  return `<button class="project-disclosure" data-project-toggle="${escapeAttribute(projectId)}"
    aria-label="${action} project ${escapeAttribute(name)}" title="${action} project">
    <span aria-hidden="true">${collapsed ? "‹" : "⌄"}</span>
  </button>`;
}

export type AggregateMarkerUpdate = {
  signature: string;
  composition: string;
  label: string;
  total: number;
  center?: string;
};

export type ActivityBlob = {
  status: string;
  createdAt: string;
  latestReceiptAt: string | null;
  latestHumanInputAt: string | null;
  completedStepIds: string[];
  steps: Array<{ id: string }>;
};

export type ActivityProject = { id: string; name: string; blobs: ActivityBlob[] };

export type ProgressBlob = {
  id: string;
  title: string;
  status?: string;
  completedStepIds: string[];
  steps: Array<{ id: string }>;
};

export function aggregateProgressGradient(completed: number, total: number): string {
  const degrees = total > 0 ? Math.max(0, Math.min(360, completed / total * 360)) : 0;
  if (degrees === 0) return "conic-gradient(from -90deg, #aeb7b1 0deg 360deg)";
  if (degrees === 360) return "conic-gradient(from -90deg, var(--green) 0deg 360deg)";
  return `conic-gradient(from -90deg, var(--green) 0deg ${degrees}deg, #aeb7b1 ${degrees}deg 360deg)`;
}

export function projectProgress(project: ActivityProject): number {
  const totals = project.blobs.reduce((sum, blob) => sum + blob.steps.length, 0);
  const completed = project.blobs.reduce((sum, blob) => sum + Math.min(blob.completedStepIds.length, blob.steps.length), 0);
  return totals ? completed / totals : 0;
}

export function projectHasActiveWork(project: ActivityProject, now = new Date(), days = 7): boolean {
  const cutoff = now.getTime() - days * 86_400_000;
  return project.blobs.some((blob) => {
    if (["running", "queued", "waiting", "blocked", "failed"].includes(blob.status)) return true;
    if (blob.status === "complete") return false;
    const activity = [blob.createdAt, blob.latestReceiptAt, blob.latestHumanInputAt]
      .filter((value): value is string => Boolean(value)).reduce((latest, value) =>
        Date.parse(value) > Date.parse(latest) ? value : latest);
    return Date.parse(activity) >= cutoff;
  });
}

export function sortProjects<T extends ActivityProject>(projects: T[], byProgress: boolean): T[] {
  return projects.slice().sort((left, right) => {
    const progress = byProgress ? projectProgress(right) - projectProgress(left) : 0;
    return progress || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

export function blobProgress(blob: ProgressBlob): number {
  if (blob.status === "complete") return 1;
  return blob.steps.length ? Math.min(blob.completedStepIds.length, blob.steps.length) / blob.steps.length : 0;
}

export function sortBlobs<T extends ProgressBlob>(blobs: T[]): T[] {
  return blobs.slice().sort((left, right) =>
    blobProgress(right) - blobProgress(left)
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id));
}

export type AggregateMarker = {
  dataset: Record<string, string | undefined>;
  classList: { toggle(name: string, enabled: boolean): void };
  style: { setProperty(name: string, value: string): void };
  title: string;
  setAttribute(name: string, value: string): void;
};

export function updateAggregateMarker(marker: AggregateMarker, update: AggregateMarkerUpdate): boolean {
  if (marker.dataset.aggregateState === update.signature) return false;
  marker.dataset.aggregateState = update.signature;
  marker.classList.toggle("unavailable", update.total === 0);
  marker.style.setProperty("--composition", update.composition);
  marker.style.setProperty("--center", update.center ?? "#fff");
  marker.title = update.label;
  marker.setAttribute("aria-label", update.label);
  return true;
}

export const viewerComponentScript = String.raw`
function blobNameMenuTriggerMarkup(blobId,title){return '<button class="task-name-button" data-blob-menu="'+componentEscape(blobId)+'" aria-haspopup="menu" aria-expanded="false">'+componentEscape(title)+'</button>'}
function disclosureMarkup(projectId,name,collapsed){const action=collapsed?'Expand':'Collapse';return '<button class="project-disclosure" data-project-toggle="'+componentEscape(projectId)+'" aria-label="'+action+' project '+componentEscape(name)+'" title="'+action+' project"><span aria-hidden="true">'+(collapsed?'‹':'⌄')+'</span></button>'}
function updateAggregateMarker(marker,update){if(marker.dataset.aggregateState===update.signature)return false;marker.dataset.aggregateState=update.signature;marker.classList.toggle('unavailable',!update.total);marker.style.setProperty('--composition',update.composition);marker.style.setProperty('--center',update.center||'#fff');marker.title=update.label;marker.setAttribute('aria-label',update.label);return true}
function aggregateProgressGradient(completed,total){const degrees=total?Math.max(0,Math.min(360,completed/total*360)):0;if(!degrees)return 'conic-gradient(from -90deg, #aeb7b1 0deg 360deg)';if(degrees===360)return 'conic-gradient(from -90deg, var(--green) 0deg 360deg)';return 'conic-gradient(from -90deg, var(--green) 0deg '+degrees+'deg, #aeb7b1 '+degrees+'deg 360deg)'}
function projectProgress(project){const total=project.blobs.reduce((sum,blob)=>sum+blob.steps.length,0),completed=project.blobs.reduce((sum,blob)=>sum+Math.min(blob.completedStepIds.length,blob.steps.length),0);return total?completed/total:0}
function projectHasActiveWork(project,now=new Date(),days=7){const cutoff=now.getTime()-days*86400000;return project.blobs.some(blob=>{if(['running','queued','waiting','blocked','failed'].includes(blob.status))return true;if(blob.status==='complete')return false;const activity=[blob.createdAt,blob.latestReceiptAt,blob.latestHumanInputAt].filter(Boolean).reduce((latest,value)=>Date.parse(value)>Date.parse(latest)?value:latest);return Date.parse(activity)>=cutoff})}
function sortProjects(projects,byProgress){return projects.slice().sort((left,right)=>(byProgress?projectProgress(right)-projectProgress(left):0)||left.name.localeCompare(right.name)||left.id.localeCompare(right.id))}
function blobProgress(blob){return blob.status==="complete"?1:blob.steps.length?Math.min(blob.completedStepIds.length,blob.steps.length)/blob.steps.length:0}
function sortBlobs(blobs){return blobs.slice().sort((left,right)=>blobProgress(right)-blobProgress(left)||left.title.localeCompare(right.title)||left.id.localeCompare(right.id))}
function componentEscape(value){return String(value).replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[character]))}
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/gu, (character) => htmlCharacters[character]);
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => htmlCharacters[character]);
}

const htmlCharacters: Record<string, string> = {
  "\"": "&quot;", "&": "&amp;", "'": "&#39;", "<": "&lt;", ">": "&gt;",
};
