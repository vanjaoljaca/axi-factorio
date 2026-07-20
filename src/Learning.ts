export function previewPromptEdit(
  blob: Blob,
  stepId: string,
  kind: PromptKind,
  content: string,
): PromptEditPreview {
  const step = requireStep(discoverPipeline(blob.pipelinePath), stepId);
  const path = kind === "entry" ? step.entryPath : step.exitPath;
  const before = readFileSync(path, "utf8");
  const error = promptError(kind, before, content);
  return {
    stepId, kind, path, before, after: content,
    expectedContentHash: contentHash(before),
    diff: lineDiff(before, content),
    valid: error === null,
    error,
  };
}

export function savePromptEdit(
  blob: Blob,
  stepId: string,
  kind: PromptKind,
  content: string,
  expectedContentHash: string,
): PromptEditPreview {
  const preview = previewPromptEdit(blob, stepId, kind, content);
  if (!preview.valid) throw new Error(preview.error ?? "Prompt edit is invalid.");
  if (preview.expectedContentHash !== expectedContentHash) {
    throw new Error("Pipeline Markdown changed; preview the edit again.");
  }
  writeFileSync(preview.path, content);
  return preview;
}

export function previewBlobEdit(
  revision: BlobRevision,
  title: string,
  body: string,
): BlobEditPreview {
  const error = blobError(revision, title, body);
  return {
    before: { title: revision.title, body: revision.body },
    after: { title, body },
    expectedRevision: revision.revision,
    titleDiff: lineDiff(revision.title, title),
    bodyDiff: lineDiff(revision.body, body),
    valid: error === null,
    error,
  };
}

function blobError(revision: BlobRevision, title: string, body: string): string | null {
  if (!title.trim()) return "Blob title cannot be empty.";
  if (!body.trim()) return "Blob content cannot be empty.";
  if (title === revision.title && body === revision.body) return "Blob content is unchanged.";
  return null;
}

function promptError(kind: PromptKind, before: string, after: string): string | null {
  if (!after.trim()) return `${titleCase(kind)} Markdown cannot be empty.`;
  if (after.includes("\0")) return "Markdown cannot contain a NUL byte.";
  if (after === before) return "Prompt content is unchanged.";
  return null;
}

function lineDiff(before: string, after: string): DiffLine[] {
  if (before === after) return before.split("\n").map((text) => ({ kind: "same", text }));
  return [
    ...before.split("\n").map((text) => ({ kind: "remove" as const, text })),
    ...after.split("\n").map((text) => ({ kind: "add" as const, text })),
  ];
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export type PromptKind = "entry" | "exit";
export type DiffLine = { kind: "same" | "remove" | "add"; text: string };
export type PromptEditPreview = {
  stepId: string;
  kind: PromptKind;
  path: string;
  before: string;
  after: string;
  expectedContentHash: string;
  diff: DiffLine[];
  valid: boolean;
  error: string | null;
};
export type BlobEditPreview = {
  before: { title: string; body: string };
  after: { title: string; body: string };
  expectedRevision: number;
  titleDiff: DiffLine[];
  bodyDiff: DiffLine[];
  valid: boolean;
  error: string | null;
};

import type { Blob, BlobRevision } from "./Types.ts";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { discoverPipeline, requireStep } from "./Pipeline.ts";
