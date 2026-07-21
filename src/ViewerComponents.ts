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
    <span aria-hidden="true">${collapsed ? "›" : "⌄"}</span>
  </button>`;
}

export const viewerComponentScript = String.raw`
function blobNameMenuTriggerMarkup(blobId,title){return '<button class="task-name-button" data-blob-menu="'+componentEscape(blobId)+'" aria-haspopup="menu" aria-expanded="false">'+componentEscape(title)+'</button>'}
function disclosureMarkup(projectId,name,collapsed){const action=collapsed?'Expand':'Collapse';return '<button class="project-disclosure" data-project-toggle="'+componentEscape(projectId)+'" aria-label="'+action+' project '+componentEscape(name)+'" title="'+action+' project"><span aria-hidden="true">'+(collapsed?'›':'⌄')+'</span></button>'}
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
