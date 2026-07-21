export function cursorActionMarkup(blobId: string, action: CursorActionState): string {
  const explanation = escapeAttribute(action.explanation);
  const label = action.enabled ? "Open in Cursor" : action.label;
  return `<span class="control-tip cursor-tip" data-tip="${explanation}" ${disabledFocus(action)}>
    <button class="run-control cursor" data-action="open-cursor" data-blob="${escapeAttribute(blobId)}"
      aria-label="${escapeAttribute(label)}" title="${explanation}" ${action.enabled ? "" : "disabled"}>
      ${cursorIcon()}<span class="cursor-label">${label}</span>
    </button>
  </span>`;
}

function disabledFocus(action: CursorActionState): string {
  return action.enabled ? "" : `tabindex="0" aria-label="${escapeAttribute(action.explanation)}"`;
}

function cursorIcon(): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M8 8l5-5M9 3h4v4"/></svg>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => htmlCharacters[character]);
}

const htmlCharacters: Record<string, string> = {
  "\"": "&quot;", "&": "&amp;", "'": "&#39;", "<": "&lt;", ">": "&gt;",
};

import type { CursorActionState } from "./CursorAction.ts";
