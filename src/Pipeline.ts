export function discoverPipeline(pipelinePath: string): StepDefinition[] {
  const root = resolve(pipelinePath);
  const files = readdirSync(root).filter((file) => promptPattern.test(file));
  const steps = groupPromptFiles(root, files);
  validateSteps(steps);
  return steps.sort(compareSteps);
}

export function nextStep(blob: Blob, steps: StepDefinition[]): StepDefinition | null {
  if (blob.state === "complete") return null;
  return requireStep(steps, blob.state);
}

export function snapshotDefinition(step: StepDefinition, pipelinePath: string): DefinitionSnapshot {
  const entry = readFileSync(step.entryPath, "utf8");
  const exit = readFileSync(step.exitPath, "utf8");
  const gitSha = gitHead(pipelinePath);
  const contentHash = createHash("sha256").update(entry).update("\0").update(exit).digest("hex");
  return { gitSha, contentHash, entry, exit };
}

export function isHumanPip(step: StepDefinition): boolean {
  return step.id.startsWith("human.")
    && !readFileSync(step.entryPath, "utf8").trim()
    && !readFileSync(step.exitPath, "utf8").trim();
}

export function requireStep(steps: StepDefinition[], stepId: string): StepDefinition {
  const step = steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Pipeline step ${stepId} was not found.`);
  return step;
}

function groupPromptFiles(root: string, files: string[]): StepDefinition[] {
  const grouped = new Map<string, Partial<StepDefinition>>();
  for (const file of files) addPromptFile(grouped, root, file);
  return [...grouped.values()].map((step) => step as StepDefinition);
}

function addPromptFile(grouped: StepMap, root: string, file: string): void {
  const match = file.match(promptPattern);
  if (!match?.groups) return;
  const id = `${match.groups.group}.${match.groups.name}`;
  const step = grouped.get(id) ?? { id, order: Number(match.groups.order) };
  if (step.order !== Number(match.groups.order)) throw new Error(`Pipeline step ${id} has conflicting order numbers.`);
  step[match.groups.kind === "entry" ? "entryPath" : "exitPath"] = join(root, file);
  grouped.set(id, step);
}

function validateSteps(steps: StepDefinition[]): void {
  if (!steps.length) throw new Error("Pipeline contains no entry/exit prompt pairs.");
  const incomplete = steps.find((step) => !step.entryPath || !step.exitPath);
  if (incomplete) throw new Error(`Pipeline step ${incomplete.id} is missing entry or exit.`);
  const orders = new Set<number>();
  for (const step of steps) {
    if (orders.has(step.order)) throw new Error(`Pipeline order ${step.order} is used more than once.`);
    orders.add(step.order);
  }
}

function compareSteps(left: StepDefinition, right: StepDefinition): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function gitHead(path: string): string {
  try {
    return execFileSync("git", ["-C", resolve(path), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`Pipeline definitions must live in Git: ${resolve(path)}`);
  }
}

type StepMap = Map<string, Partial<StepDefinition>>;

const promptPattern =
  /^(?<order>\d+)\.(?<group>[a-z0-9-]+)\.(?<name>[a-z0-9-]+)\.(?<kind>entry|exit)\.md$/;

import type { DefinitionSnapshot, StepDefinition, Blob } from "./Types.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
