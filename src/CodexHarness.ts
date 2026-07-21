export class CodexHarness implements AgentHarness {
  readonly name = "codex";
  readonly model = "codex-cli-default";
  private readonly active = new Map<string, ActiveRun>();
  private readonly lifecycle: CodexLifecycleReader;

  constructor(
    platform: NodeJS.Platform = process.platform,
    lifecycle: CodexLifecycleReader = readCodexLifecycle,
  ) {
    if (platform === "win32") {
      throw new Error("Codex execution is unsupported on Windows because process-tree termination cannot be guaranteed.");
    }
    this.lifecycle = lifecycle;
  }

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.invoke({ ...input, continuationThreadId: null }, observer);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.invoke({ ...input, continuationThreadId: input.externalRunId }, observer);
  }

  async cancel(input: HarnessCancelInput): Promise<void> {
    const active = this.active.get(input.runId);
    if (!active) return;
    active.controller.abort(Object.assign(new Error(input.reason), { name: "AbortError" }));
    await active.done;
  }

  async reconcile(input: HarnessReconcileInput): Promise<HarnessExternalState> {
    return this.lifecycle(input.externalRunId);
  }

  private async invoke(input: CodexInput, observer: HarnessObserver): Promise<HarnessResult> {
    const controller = new AbortController();
    let finish = () => undefined;
    const done = new Promise<void>((resolve) => finish = resolve);
    this.active.set(input.runId, { controller, done });
    try {
      return await executeCodex(input, controller.signal, observer);
    } finally {
      this.active.delete(input.runId);
      finish();
    }
  }
}

async function executeCodex(
  input: CodexInput,
  signal: AbortSignal,
  observer: HarnessObserver,
): Promise<HarnessResult> {
  observer.event({ type: "status", status: "running", message: "entry" });
  const onExternalRun = (externalRunId: string) =>
    observer.event({ type: "external-run", externalRunId });
  const executionInput = { ...input, signal };
  const writableDirectories = resolveGitWritableDirectories(executionRoot(input));
  const entry = await runEntry(executionInput, onExternalRun, writableDirectories);
  const localEndpoint = await observer.startLocalEndpoint?.() ?? null;
  observer.event({ type: "status", status: "running", message: "exit" });
  const exitPrompt = buildExitPrompt(input, localEndpoint);
  const exit = await runCodex(
    exitArgs(executionRoot(input), entry.externalRunId, exitPrompt, writableDirectories),
    executionInput.signal,
    onExternalRun,
  );
  const result = parseExitResult(exit.finalMessage);
  const endpointArtifacts = localEndpoint
    ? [`local-endpoint:${localEndpoint.url}`, `git-head:${localEndpoint.gitHead}`]
    : [];
  const outputArtifacts = [...new Set([
    ...result.outputArtifacts, ...endpointArtifacts, `codex-thread:${entry.externalRunId}`,
  ])];
  for (const artifactRef of outputArtifacts) observer.event({ type: "artifact", artifactRef });
  return {
    decision: result.decision,
    reason: result.reason,
    outputArtifacts,
    externalRunId: entry.externalRunId,
  };
}

async function runEntry(
  input: CodexInput,
  onExternalRun: ExternalRunObserver,
  writableDirectories: string[],
): Promise<ProcessResult> {
  const prompt = input.continuationThreadId ? buildContinuationPrompt(input) : buildEntryPrompt(input);
  const args = input.continuationThreadId
    ? continuationArgs(executionRoot(input), input.continuationThreadId, prompt, writableDirectories)
    : entryArgs(executionRoot(input), prompt, writableDirectories);
  return runCodex(args, input.signal, onExternalRun);
}

function entryArgs(cwd: string, prompt: string, writableDirectories: string[]): string[] {
  return [...commonExecArgs(cwd, writableDirectories), "--", prompt];
}

function exitArgs(
  cwd: string,
  threadId: string,
  prompt: string,
  writableDirectories: string[],
): string[] {
  return [
    ...commonExecArgs(cwd, writableDirectories), "--output-schema", exitSchemaPath,
    "resume", threadId, "--", prompt,
  ];
}

function continuationArgs(
  cwd: string,
  threadId: string,
  prompt: string,
  writableDirectories: string[],
): string[] {
  return [...commonExecArgs(cwd, writableDirectories), "resume", threadId, "--", prompt];
}

function commonExecArgs(cwd: string, writableDirectories: string[]): string[] {
  return [
    "exec", "--ignore-user-config", "--json", "--color", "never",
    "--sandbox", "workspace-write", "-C", cwd,
    ...writableDirectories.flatMap((path) => ["--add-dir", path]),
  ];
}

async function runCodex(
  args: string[],
  signal: AbortSignal | undefined,
  onExternalRun: ExternalRunObserver,
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
  onExternalRun: ExternalRunObserver,
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
  onExternalRun: ExternalRunObserver,
): Promise<void> {
  const lines = createInterface({ input: stdout });
  for await (const line of lines) captureLine(state, line, onExternalRun);
}

function captureLine(state: ProcessState, line: string, onExternalRun: ExternalRunObserver): void {
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

function buildEntryPrompt(input: CodexInput): string {
  return `${input.definition.entry.trim()}\n\n${runtimeMarker}\n${JSON.stringify({
    phase: "entry",
    blobId: input.blob.id,
    title: input.blob.title,
    body: input.blob.body,
    stepId: input.step.id,
    projectRoot: input.blob.cwd,
    executionWorkspaceRoot: executionRoot(input),
    inputArtifacts: input.inputArtifacts,
  }, null, 2)}`.trim();
}

function buildContinuationPrompt(input: CodexInput): string {
  return `${runtimeMarker}
Continue blob ${input.blob.id} at the same step ${input.step.id} using the fresh human input below.
${JSON.stringify({
    phase: "continuation",
    projectRoot: input.blob.cwd,
    executionWorkspaceRoot: executionRoot(input),
    humanInputs: input.humanInputs,
    approvalEvidence: input.approvalEvidence,
    inputArtifacts: input.inputArtifacts,
  }, null, 2)}`.trim();
}

function buildExitPrompt(input: CodexInput, localEndpoint: LocalEndpointSession | null): string {
  const endpointContext = localEndpoint
    ? `\nFactorio-managed local endpoint: ${localEndpoint.url}\nVerified workspace: ${localEndpoint.cwd}\nVerified Git head: ${localEndpoint.gitHead}`
    : "";
  return `${input.definition.exit.trim()}\n\n${runtimeMarker}
Evaluate blob ${input.blob.id} at step ${input.step.id}.
Project root / app root: ${input.blob.cwd}
Execution workspace root: ${executionRoot(input)}${endpointContext}
Return only the schema-conforming JSON decision:
- advance: this step passed and the item may move down the conveyor
- retry: run this same step again
- blocked: explicit external input is required
Include a concise reason and an outputArtifacts array of durable artifact references.`.trim();
}

function executionRoot(input: CodexInput): string {
  return input.blob.executionWorkspaceRoot || input.blob.cwd;
}

function parseExitResult(message: string): Pick<HarnessResult, "decision" | "reason" | "outputArtifacts"> {
  const parsed = JSON.parse(message) as { decision?: string; reason?: string; outputArtifacts?: unknown };
  if (!["advance", "retry", "blocked"].includes(parsed.decision ?? "")) {
    throw new Error(`Invalid exit decision: ${message}`);
  }
  if (typeof parsed.reason !== "string") throw new Error("Exit result requires a reason.");
  if (!Array.isArray(parsed.outputArtifacts) || !parsed.outputArtifacts.every((item) => typeof item === "string")) {
    throw new Error("Exit result requires string output artifact references.");
  }
  return {
    decision: parsed.decision as HarnessDecision,
    reason: parsed.reason,
    outputArtifacts: parsed.outputArtifacts as string[],
  };
}

async function readCodexLifecycle(externalRunId: string): Promise<HarnessExternalState> {
  try {
    const thread = await readCodexThread(externalRunId);
    return codexThreadState(thread, externalRunId);
  } catch (error) {
    const classified = classifyCodexLifecycleFailure(error, externalRunId);
    if (classified) return classified;
    if (isMissingThread(error)) {
      return { status: "missing", reason: `Codex external task ${externalRunId} was not found.` };
    }
    throw error;
  }
}

export function classifyCodexLifecycleFailure(
  error: unknown,
  externalRunId: string,
): HarnessExternalState | null {
  if (!/rollout[\s\S]*is empty|empty session file/iu.test(errorMessage(error))) return null;
  return {
    status: "interrupted",
    reason: `Codex external task ${externalRunId} has an empty, unresumable session record.`,
    recovery: "restart",
  };
}

async function readCodexThread(externalRunId: string): Promise<CodexThread> {
  const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const state = createAppServerState(child);
  sendAppServerRequest(child, 1, "initialize", initializeParams);
  return waitForThreadRead(child, state, externalRunId);
}

function waitForThreadRead(
  child: ChildProcess,
  state: AppServerState,
  externalRunId: string,
): Promise<CodexThread> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    const timeout = setTimeout(
      () => finishAppServer(child, lines, reject, new Error("Codex lifecycle probe timed out.")),
      lifecycleProbeTimeoutMs,
    );
    child.stderr?.on("data", (chunk) => captureAppServerStderr(state, chunk));
    child.once("error", (error) => finishAppServer(child, lines, reject, error, timeout));
    lines.on("line", (line) => handleAppServerLine(
      child, lines, state, line, externalRunId, resolve, reject, timeout,
    ));
  });
}

function handleAppServerLine(
  child: ChildProcess,
  lines: ReturnType<typeof createInterface>,
  state: AppServerState,
  line: string,
  externalRunId: string,
  resolve: (thread: CodexThread) => void,
  reject: (error: Error) => void,
  timeout: NodeJS.Timeout,
): void {
  const response = JSON.parse(line) as AppServerResponse;
  if (response.id === 1) {
    sendAppServerRequest(child, 2, "thread/read", { threadId: externalRunId, includeTurns: true });
    return;
  }
  if (response.id !== 2) return;
  if (response.error) {
    finishAppServer(child, lines, reject, new Error(JSON.stringify(response.error)), timeout);
    return;
  }
  clearTimeout(timeout);
  lines.close();
  child.kill("SIGTERM");
  resolve(response.result!.thread);
}

function finishAppServer(
  child: ChildProcess,
  lines: ReturnType<typeof createInterface>,
  reject: (error: Error) => void,
  error: Error,
  timeout?: NodeJS.Timeout,
): void {
  if (timeout) clearTimeout(timeout);
  lines.close();
  child.kill("SIGTERM");
  reject(error);
}

function sendAppServerRequest(
  child: ChildProcess,
  id: number,
  method: string,
  params: Record<string, unknown>,
): void {
  child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
}

function createAppServerState(_child: ChildProcess): AppServerState {
  return { stderr: "" };
}

function captureAppServerStderr(state: AppServerState, chunk: unknown): void {
  state.stderr = `${state.stderr}${String(chunk)}`.slice(-8_000);
}

function codexThreadState(thread: CodexThread, externalRunId: string): HarnessExternalState {
  if (thread.status.type === "systemError") {
    return { status: "failed", reason: `Codex external task ${externalRunId} reported systemError.` };
  }
  const latest = thread.turns.at(-1);
  if (!latest) return missingTurnState(thread, externalRunId);
  if (["completed", "inProgress"].includes(latest.status)) return { status: "running" };
  if (isFreshIncompleteTurn(thread, latest)) return { status: "running" };
  const unloaded = thread.status.type === "notLoaded" ? " while notLoaded" : "";
  if (latest.status === "interrupted") {
    return {
      status: "interrupted",
      reason: `Codex external task ${externalRunId} turn ${latest.id} was interrupted${unloaded}.`,
      recovery: hasNoAgentActivity(latest) ? "restart" : undefined,
    };
  }
  return {
    status: "failed",
    reason: `Codex external task ${externalRunId} turn ${latest.id} failed: ${errorText(latest.error)}.`,
  };
}

function missingTurnState(thread: CodexThread, externalRunId: string): HarnessExternalState {
  if (isFresh(thread.updatedAt)) return { status: "running" };
  return {
    status: "missing",
    reason: `Codex external task ${externalRunId} had no active turn after the activity timeout.`,
  };
}

function isFreshIncompleteTurn(thread: CodexThread, turn: CodexTurn): boolean {
  return thread.status.type === "notLoaded"
    && turn.status === "interrupted"
    && turn.completedAt == null
    && turn.error == null
    && !hasNoAgentActivity(turn)
    && isFresh(thread.updatedAt);
}

function hasNoAgentActivity(turn: CodexTurn): boolean {
  return (turn.items ?? []).every((item) => item.type === "userMessage");
}

function isFresh(updatedAt: number): boolean {
  return Date.now() - epochMilliseconds(updatedAt) < activeTurnFreshnessMs;
}

function epochMilliseconds(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function isMissingThread(error: unknown): boolean {
  return /not found|unknown thread|thread.*missing/iu.test(errorMessage(error));
}

function errorText(error: unknown): string {
  if (!error) return "no provider error was reported";
  return typeof error === "string" ? error : JSON.stringify(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
type ActiveRun = { controller: AbortController; done: Promise<void> };
type AppServerState = { stderr: string };
type AppServerResponse = {
  id?: number;
  result?: { thread: CodexThread };
  error?: unknown;
};
type CodexLifecycleReader = (externalRunId: string) => Promise<HarnessExternalState>;
type CodexThread = {
  status: { type: "notLoaded" | "idle" | "systemError" | "active" };
  updatedAt: number;
  turns: CodexTurn[];
};
type CodexTurn = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: unknown;
  completedAt?: number | null;
  items?: Array<{ type?: string }>;
};
type CodexInput = HarnessRunInput & {
  continuationThreadId: string | null;
  signal?: AbortSignal;
};
type ExternalRunObserver = (externalRunId: string) => void;

const runtimeMarker = "---\naxi-factorio runtime context";
const exitSchemaPath = fileURLToPath(new URL("./exit-result.schema.json", import.meta.url));
const terminationGraceMs = 2_000;
const processCheckMs = 10;
const lifecycleProbeTimeoutMs = 10_000;
const activeTurnFreshnessMs = 5 * 60_000;
const initializeParams = {
  clientInfo: { name: "axi-factorio", title: "axi-factorio Codex harness", version: "0.1" },
  capabilities: null,
};

import type { HarnessDecision } from "./Types.ts";
import { resolveGitWritableDirectories } from "./GitWritableDirectories.ts";
import type {
  AgentHarness,
  HarnessCancelInput,
  HarnessExternalState,
  HarnessObserver,
  HarnessReconcileInput,
  HarnessResult,
  HarnessResumeInput,
  HarnessRunInput,
  HarnessStartInput,
} from "./Harness.ts";
import type { LocalEndpointSession } from "./LocalEndpointSupervisor.ts";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
