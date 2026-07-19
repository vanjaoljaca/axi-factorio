export class CodexAdapter implements ToolAdapter {
  readonly name = "codex";

  constructor(platform: NodeJS.Platform = process.platform) {
    if (platform === "win32") {
      throw new Error("Codex execution is unsupported on Windows because process-tree termination cannot be guaranteed.");
    }
  }

  async execute(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<AdapterResult> {
    const entry = await runEntry(input, onExternalRun);
    const exitPrompt = buildExitPrompt(input);
    const exit = await runCodex(
      exitArgs(input.blob.cwd, entry.externalRunId, exitPrompt),
      input.signal,
      onExternalRun,
    );
    const result = parseExitResult(exit.finalMessage);
    return {
      status: result.status,
      reason: result.reason,
      outputArtifacts: [...new Set([...result.outputArtifacts, `codex-thread:${entry.externalRunId}`])],
      externalRunId: entry.externalRunId,
    };
  }
}

async function runEntry(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<ProcessResult> {
  const prompt = input.continuationThreadId ? buildContinuationPrompt(input) : buildEntryPrompt(input);
  const args = input.continuationThreadId
    ? continuationArgs(input.blob.cwd, input.continuationThreadId, prompt)
    : entryArgs(input.blob.cwd, prompt);
  return runCodex(args, input.signal, onExternalRun);
}

function entryArgs(cwd: string, prompt: string): string[] {
  return ["exec", "--json", "--color", "never", "--sandbox", "workspace-write", "-C", cwd, prompt];
}

function exitArgs(cwd: string, threadId: string, prompt: string): string[] {
  return [
    "exec", "--json", "--color", "never", "-C", cwd,
    "--output-schema", exitSchemaPath, "resume", threadId, prompt,
  ];
}

function continuationArgs(cwd: string, threadId: string, prompt: string): string[] {
  return ["exec", "--json", "--color", "never", "-C", cwd, "resume", threadId, prompt];
}

async function runCodex(
  args: string[],
  signal: AbortSignal | undefined,
  onExternalRun: ExternalRunHandler,
): Promise<ProcessResult> {
  signal?.throwIfAborted();
  const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  const state = createProcessState();
  child.stderr.on("data", (chunk) => captureStderr(state, chunk));
  await monitorProcess(child, state, signal, onExternalRun);
  return requireResult(state);
}

async function monitorProcess(
  child: ChildProcess,
  state: ProcessState,
  signal: AbortSignal | undefined,
  onExternalRun: ExternalRunHandler,
): Promise<void> {
  const exited = waitForExit(child, state);
  const abort = createAbortWait(signal);
  try {
    await Promise.race([
      Promise.all([readJsonLines(child.stdout!, state, onExternalRun), exited]),
      abort.promise,
    ]);
  } catch (error) {
    await terminateProcess(child, exited);
    throw error;
  } finally {
    abort.dispose();
  }
}

async function terminateProcess(child: ChildProcess, exited: Promise<void>): Promise<void> {
  signalProcessTree(child, "SIGTERM");
  const treeExited = Promise.all([
    exited.catch(() => undefined),
    waitForProcessTreeExit(child),
  ]).then(() => undefined);
  if (!await settlesWithin(treeExited, terminationGraceMs)) signalProcessTree(child, "SIGKILL");
  await treeExited;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (!processTreeIsGone(error)) throw error;
  }
}

async function waitForProcessTreeExit(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  while (processGroupExists(child.pid)) await pause(processCheckMs);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !processTreeIsGone(error);
  }
}

function processTreeIsGone(error: unknown): boolean {
  return ["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createAbortWait(signal: AbortSignal | undefined): AbortWait {
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => rejectAbort = reject);
  const abort = () => rejectAbort(signal?.reason ?? abortError());
  signal?.addEventListener("abort", abort, { once: true });
  return { promise, dispose: () => signal?.removeEventListener("abort", abort) };
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), milliseconds);
    const finish = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    promise.then(finish, finish);
  });
}

async function readJsonLines(
  stdout: NodeJS.ReadableStream,
  state: ProcessState,
  onExternalRun: ExternalRunHandler,
): Promise<void> {
  const lines = createInterface({ input: stdout });
  for await (const line of lines) captureLine(state, line, onExternalRun);
}

function captureLine(state: ProcessState, line: string, onExternalRun: ExternalRunHandler): void {
  if (!line.trim()) return;
  const event = JSON.parse(line) as CodexStreamEvent;
  state.externalRunId = event.thread_id ?? state.externalRunId;
  state.finalMessage = agentMessage(event) ?? state.finalMessage;
  if (event.thread_id) onExternalRun(event.thread_id);
}

function captureStderr(state: ProcessState, chunk: unknown): void {
  state.stderr = `${state.stderr}${String(chunk)}`.slice(-16_000);
}

function waitForExit(child: ChildProcess, state: ProcessState): Promise<void> {
  return new Promise((resolve, reject) => {
    let spawnError: Error | null = null;
    child.once("error", (error) => spawnError = error);
    child.once("close", (code) => {
      if (spawnError) reject(spawnError);
      else if (code === 0) resolve();
      else reject(new Error(`codex exec exited ${code}: ${state.stderr.trim()}`));
    });
  });
}

function requireResult(state: ProcessState): ProcessResult {
  if (!state.externalRunId) throw new Error("Codex stream did not include thread.started.");
  return { externalRunId: state.externalRunId, finalMessage: state.finalMessage };
}

function agentMessage(event: CodexStreamEvent): string | null {
  if (event.type !== "item.completed" || event.item?.type !== "agent_message") return null;
  return event.item.text ?? "";
}

function createProcessState(): ProcessState {
  return { externalRunId: null, finalMessage: "", stderr: "" };
}

function buildEntryPrompt(input: AdapterInput): string {
  return `${input.definition.entry.trim()}\n\n${runtimeMarker}\n${JSON.stringify({
    phase: "entry",
    blobId: input.blob.id,
    title: input.blob.title,
    body: input.blob.body,
    stepId: input.step.id,
    inputArtifacts: input.inputArtifacts,
  }, null, 2)}`.trim();
}

function buildContinuationPrompt(input: AdapterInput): string {
  return `${runtimeMarker}
Continue blob ${input.blob.id} at the same step ${input.step.id} using the fresh human input below.
${JSON.stringify({
    phase: "continuation",
    humanInputs: input.humanInputs,
    approvalEvidence: input.approvalEvidence,
    inputArtifacts: input.inputArtifacts,
  }, null, 2)}`.trim();
}

function buildExitPrompt(input: AdapterInput): string {
  return `${input.definition.exit.trim()}\n\n${runtimeMarker}
Evaluate blob ${input.blob.id} at step ${input.step.id}.
Return only the schema-conforming JSON decision:
- advance: this step passed and the item may move down the conveyor
- retry: run this same step again
- blocked: explicit external input is required
Include a concise reason and an outputArtifacts array of durable artifact references.`.trim();
}

function parseExitResult(message: string): Pick<AdapterResult, "status" | "reason" | "outputArtifacts"> {
  const parsed = JSON.parse(message) as { decision?: string; reason?: string; outputArtifacts?: unknown };
  if (!["advance", "retry", "blocked"].includes(parsed.decision ?? "")) {
    throw new Error(`Invalid exit decision: ${message}`);
  }
  if (typeof parsed.reason !== "string") throw new Error("Exit result requires a reason.");
  if (!Array.isArray(parsed.outputArtifacts) || !parsed.outputArtifacts.every((item) => typeof item === "string")) {
    throw new Error("Exit result requires string output artifact references.");
  }
  return {
    status: parsed.decision as AdapterOutcome,
    reason: parsed.reason,
    outputArtifacts: parsed.outputArtifacts as string[],
  };
}

type CodexStreamEvent = {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  [key: string]: unknown;
};
type ProcessState = { externalRunId: string | null; finalMessage: string; stderr: string };
type ProcessResult = { externalRunId: string; finalMessage: string };
type AbortWait = { promise: Promise<never>; dispose: () => void };

const runtimeMarker = "---\naxi-factorio runtime context";
const exitSchemaPath = fileURLToPath(new URL("./exit-result.schema.json", import.meta.url));
const terminationGraceMs = 2_000;
const processCheckMs = 10;

import type { AdapterInput, AdapterOutcome, AdapterResult } from "./Types.ts";
import type { ExternalRunHandler, ToolAdapter } from "./Adapter.ts";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
