export function completionPolicy(exit: string): CompletionPolicy {
  const requirements = markdownArtifactPaths(exit);
  if (requirements.length) return { kind: "artifacts", requirements };
  return exit.trim() ? { kind: "classifier" } : { kind: "completion" };
}

export function verifyArtifacts(exit: string, workspaceRoot: string): ArtifactVerification {
  const policy = completionPolicy(exit);
  if (policy.kind !== "artifacts") return { policy, present: [], missing: [] };
  const root = resolve(workspaceRoot);
  const checked = policy.requirements.map((requirement) => checkedArtifact(root, requirement));
  return {
    policy,
    present: checked.filter((artifact) => artifact.present).map((artifact) => `file:${artifact.path}`),
    missing: checked.filter((artifact) => !artifact.present).map((artifact) => artifact.requirement),
  };
}

function markdownArtifactPaths(markdown: string): string[] {
  const matches = [...markdown.matchAll(markdownLinkPattern)].map((match) => match[1]);
  return [...new Set(matches.filter(isLocalArtifact).map(normalizeTarget))];
}

function checkedArtifact(root: string, requirement: string): CheckedArtifact {
  const path = resolve(root, requirement);
  if (escapesRoot(root, path)) throw new Error(`Declared artifact escapes the execution workspace: ${requirement}`);
  return { requirement, path, present: existsSync(path) };
}

function isLocalArtifact(target: string): boolean {
  return Boolean(target) && !target.startsWith("#") && !schemePattern.test(target);
}

function normalizeTarget(target: string): string {
  try {
    return decodeURIComponent(target.split("#", 1)[0]);
  } catch {
    throw new Error(`Declared artifact link is not valid URI text: ${target}`);
  }
}

function escapesRoot(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
}

export type CompletionPolicy =
  | { kind: "classifier" }
  | { kind: "completion" }
  | { kind: "artifacts"; requirements: string[] };

export type ArtifactVerification = {
  policy: CompletionPolicy;
  present: string[];
  missing: string[];
};

type CheckedArtifact = { requirement: string; path: string; present: boolean };

const markdownLinkPattern = /\[[^\]]*\]\(([^\s)]+)\)/gu;
const schemePattern = /^[a-z][a-z0-9+.-]*:/iu;

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
