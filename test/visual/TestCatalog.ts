export type TestVisualKind =
  | "conveyor-replay"
  | "service-timeline"
  | "terminal-proof";

export type TestCatalogItem = {
  id: string;
  category: string;
  file: string;
  name: string;
  visualKind: TestVisualKind;
  visualLabel: string;
  visualDescription: string;
};

export type TestRunFrame = {
  label: string;
  status: "running" | "passed" | "failed";
  events: TestRunEvent[];
  transcript: string[];
};

export type TestRunEvent = {
  event: string;
  detail: string;
  status: string;
};

export type TestRun = {
  testId: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  frames: TestRunFrame[];
};

export function listVisualTests(): TestCatalogItem[] {
  return testFiles().flatMap(readTests);
}

export function getVisualTest(id: string): TestCatalogItem {
  const item = listVisualTests().find((test) => test.id === id);
  if (!item) throw new Error(`Unknown test: ${id}`);
  return item;
}

export async function runVisualTest(item: TestCatalogItem): Promise<TestRun> {
  const startedAt = Date.now();
  const result = await executeTest(item);
  return {
    testId: item.id,
    passed: result.code === 0,
    exitCode: result.code,
    durationMs: Date.now() - startedAt,
    frames: createFrames(result, item),
  };
}

function testFiles(): string[] {
  return readdirSync(testsRoot)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(testsRoot, name));
}

function readTests(file: string): TestCatalogItem[] {
  const category = basename(file, ".test.ts");
  const names = [...readFileSync(file, "utf8").matchAll(/\btest\("([^"]+)"/g)];
  return names.map((match, index) => visualTest(file, category, match[1], index));
}

function visualTest(file: string, category: string, name: string, index: number): TestCatalogItem {
  const visualKind = classify(category);
  return {
    id: `${category.toLowerCase()}-${index + 1}`,
    category: category.replace(/([a-z])([A-Z])/g, "$1 $2"),
    file: relative(root, file),
    name,
    visualKind,
    visualLabel: visualLabels[visualKind],
    visualDescription: visualDescriptions[visualKind],
  };
}

function classify(category: string): TestVisualKind {
  if (category === "Service") return "service-timeline";
  if (category === "Runner" || category === "TestHarness") return "conveyor-replay";
  return "terminal-proof";
}

function executeTest(item: TestCatalogItem): Promise<ExecutionResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, testArguments(item), { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

function testArguments(item: TestCatalogItem): string[] {
  const exactName = `^${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  return [
    "--disable-warning=ExperimentalWarning",
    "--test",
    "--test-name-pattern",
    exactName,
    resolve(root, item.file),
  ];
}

function createFrames(result: ExecutionResult, item: TestCatalogItem): TestRunFrame[] {
  const events = structuredEvents(`${result.stdout}\n${result.stderr}`);
  const transcript = transcriptLines(result);
  const initial = frame("Test started", "running", [], [`node --test ${item.file}`]);
  const observed = events.map((event, index) =>
    frame(`Event ${index + 1}`, "running", events.slice(0, index + 1), transcript));
  const finalStatus = result.code === 0 ? "passed" : "failed";
  return [initial, ...observed, frame(`Test ${finalStatus}`, finalStatus, events, transcript)];
}

function structuredEvents(output: string): TestRunEvent[] {
  return output.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (!value.event) return [];
      return [{
        event: String(value.event),
        status: String(value.status ?? value.blobState ?? ""),
        detail: eventDetail(value),
      }];
    } catch {
      return [];
    }
  });
}

function eventDetail(value: Record<string, unknown>): string {
  const fields = ["blobId", "stepId", "receiptId", "ownerId", "error"];
  return fields.filter((key) => value[key]).map((key) => `${key}=${value[key]}`).join(" · ");
}

function transcriptLines(result: ExecutionResult): string[] {
  return `${result.stdout}\n${result.stderr}`.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-24);
}

function frame(
  label: string,
  status: TestRunFrame["status"],
  events: TestRunEvent[],
  transcript: string[],
): TestRunFrame {
  return { label, status, events, transcript };
}

type ExecutionResult = { code: number; stdout: string; stderr: string };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testsRoot = join(root, "tests");
const visualLabels: Record<TestVisualKind, string> = {
  "conveyor-replay": "conveyor replay",
  "service-timeline": "service timeline",
  "terminal-proof": "terminal proof only",
};
const visualDescriptions: Record<TestVisualKind, string> = {
  "conveyor-replay": "Replay observable receipt events as work moves through the conveyor.",
  "service-timeline": "Watch lease, heartbeat, receipt, recovery, and shutdown events on a time axis.",
  "terminal-proof": "No meaningful animation is available; inspect the actual TAP transcript and exit status without invented state.",
};

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
