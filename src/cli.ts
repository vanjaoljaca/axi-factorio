#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--version") || args[0] === "version") return printVersion();
  if (args.includes("--help") || args[0] === "help") return showCommandHelp(helpCommand(args));
  if (args[0] === "workbench") return runWorkbench(args.slice(1));
  const options = parseGlobalOptions(args);
  const databaseAlreadyExisted = existsSync(options.databasePath);
  const database = new FactorioDatabase(options.databasePath);
  const store = new ConveyorStore(database);
  try {
    await runCommand(options.args, store, options.json, databaseAlreadyExisted);
  } finally {
    database.close();
  }
}

async function runWorkbench(args: string[]): Promise<void> {
  process.argv = [process.argv[0], process.argv[1], ...args];
  await import("./WorkbenchServer.ts");
}

async function runCommand(
  args: string[],
  store: ConveyorStore,
  json: boolean,
  databaseAlreadyExisted: boolean,
): Promise<void> {
  switch (args[0]) {
    case undefined: return showHome(store, json);
    case "init": return initialize(args.slice(1), json, databaseAlreadyExisted);
    case "add": return addBlob(args.slice(1), store, json);
    case "list":
    case "status": return listBlobs(args.slice(1), store, json);
    case "show": return showBlob(args.slice(1), store, json);
    case "receipts": return showReceipts(args.slice(1), store, json);
    case "retry": return retryBlob(args.slice(1), store, json);
    case "rewind":
    case "kick": return rewindBlob(args.slice(1), store, json, args[0]);
    case "run":
    case "evaluate": return runOne(args.slice(1), store, json);
    case "service": return runService(args.slice(1), store, json);
    default: throw usage(`unknown command ${args[0]}`, "Run `axi-factorio --help`.");
  }
}

function showHome(store: ConveyorStore, json: boolean): void {
  const blobs = store.listBlobs();
  const active = blobs.filter((blob) => blob.state !== "complete").slice(0, 10);
  printOutput({
    bin: displayPath(process.argv[1]),
    description: "Move blobs down Git-defined steps with SQLite receipts.",
    summary: stateCounts(blobs),
    blobs: active.map(blobSummary),
    done: `${blobs.filter((blob) => blob.state === "complete").length} retained`,
    help: homeHelp(blobs.length, active.length),
  }, json);
}

function initialize(args: string[], json: boolean, already: boolean): void {
  requirePositionals(parseArgs(args, {}), 0, "init accepts no positional arguments.");
  printOutput({ ok: "init -> database ready", already }, json);
}

function addBlob(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, addFlags);
  const identity = parseBlobIdentity(parsed);
  const pipelinePath = resolve(requireFlag(parsed, "--pipeline"));
  const steps = discoverPipeline(pipelinePath);
  snapshotDefinition(steps[0], pipelinePath);
  const result = store.createBlob(identity.id, {
    title: identity.title,
    body: readBody(parsed),
    cwd: resolve(firstFlag(parsed, "--cwd") ?? process.cwd()),
    pipelinePath,
    inputArtifacts: parsed.flags["--input-ref"] ?? [],
  });
  printOutput({
    ok: `add ${result.blob.id} -> ${result.blob.state}`,
    already: result.already,
    blob: blobSummary(result.blob),
    help: ["Run `axi-factorio run` or start `axi-factorio service`."],
  }, json);
}

function listBlobs(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--state": "value", "--limit": "value" });
  requirePositionals(parsed, 0, "list accepts no positional arguments.");
  const state = firstFlag(parsed, "--state");
  const limit = positiveInteger(firstFlag(parsed, "--limit") ?? "50", "--limit");
  const all = store.listBlobs().filter((blob) => !state || blob.state === state);
  printOutput({
    count: `${Math.min(all.length, limit)} of ${all.length} total`,
    blobs: all.slice(0, limit).map(blobSummary),
    help: all.length
      ? ["Run `axi-factorio show <id>` for blob details."]
      : ["Run `axi-factorio add <id> \"<title>\" --pipeline <dir>`."],
  }, json);
}

function showBlob(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--full": "boolean" });
  requirePositionals(parsed, 1, "show requires one blob ID.");
  const blob = requireBlob(store, parsed.positionals[0]);
  const full = hasFlag(parsed, "--full");
  const body = contentPreview(blob.body, full);
  printOutput({
    blob: { ...blobDetail(blob), body: body.text, inputArtifacts: blob.inputArtifacts },
    receipts: store.listReceipts(blob.id).map((receipt) => receiptSummary(receipt, full)),
    help: body.truncated
      ? [`Run \`axi-factorio show ${blob.id} --full\` for the complete body (${blob.body.length} chars).`]
      : [],
  }, json);
}

function showReceipts(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--limit": "value", "--full": "boolean" });
  if (parsed.positionals.length > 1) throw usage("receipts accepts at most one blob ID.");
  const limit = positiveInteger(firstFlag(parsed, "--limit") ?? "50", "--limit");
  const all = store.listReceipts(parsed.positionals[0]);
  const full = hasFlag(parsed, "--full");
  printOutput({
    count: `${Math.min(all.length, limit)} of ${all.length} total`,
    receipts: all.slice(-limit).map((receipt) => receiptSummary(receipt, full)),
    help: full || !all.length ? [] : ["Run `axi-factorio receipts [<id>] --full` for hashes and artifacts."],
  }, json);
}

function retryBlob(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, {});
  requirePositionals(parsed, 1, "retry requires one blob ID.");
  const result = store.retryBlob(parsed.positionals[0]);
  printOutput({ ok: `retry ${result.blob.id} -> ${result.blob.state}`, already: result.already }, json);
}

function rewindBlob(
  args: string[],
  store: ConveyorStore,
  json: boolean,
  action: "rewind" | "kick",
): void {
  const parsed = parseArgs(args, {});
  requirePositionals(parsed, 2, `${action} requires a blob ID and stable step ID.`);
  const blob = requireBlob(store, parsed.positionals[0]);
  const steps = discoverPipeline(blob.pipelinePath);
  const step = requireStep(steps, parsed.positionals[1]);
  const result = store.rewindBlob(blob.id, step, steps);
  printOutput({
    ok: `${action} ${blob.id} -> ${step.id}`,
    already: result.already,
    blob: blobSummary(result.blob),
    help: ["Run `axi-factorio run` to move the blob forward again."],
  }, json);
}

async function runOne(args: string[], store: ConveyorStore, json: boolean): Promise<void> {
  requirePositionals(parseArgs(args, {}), 0, "run accepts no positional arguments.");
  const runner = new ConveyorRunner(store, new CodexAdapter());
  const processed = await new ConveyorService(store, runner).runOnce(serviceAbortController().signal);
  printOutput({
    run: processed ? "processed" : "idle",
    help: processed ? ["Run `axi-factorio` to inspect live state."] : [],
  }, json);
}

async function runService(args: string[], store: ConveyorStore, json: boolean): Promise<void> {
  const parsed = parseArgs(args, { "--poll-ms": "value" });
  requirePositionals(parsed, 0, "service accepts no positional arguments.");
  const pollMs = positiveInteger(firstFlag(parsed, "--poll-ms") ?? "1000", "--poll-ms");
  if (pollMs < 50) throw usage("--poll-ms must be at least 50.");
  const controller = serviceAbortController();
  const runner = new ConveyorRunner(store, new CodexAdapter());
  await new ConveyorService(store, runner, pollMs).run(controller.signal);
  printOutput({ ok: "service -> stopped" }, json);
}

function parseGlobalOptions(args: string[]): GlobalOptions {
  const parsed = extractGlobals(args);
  const databasePath = resolve(firstFlag(parsed, "--db") ?? defaultDatabasePath());
  return { databasePath, json: hasFlag(parsed, "--json"), args: parsed.args };
}

function extractGlobals(args: string[]): ExtractedGlobals {
  const result: ExtractedGlobals = { flags: {}, args: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--json") addFlag(result.flags, value, "true");
    else if (value === "--db") addFlag(result.flags, value, requireValue(args[++index], "--db requires a value."));
    else result.args.push(value);
  }
  return result;
}

function parseArgs(args: string[], spec: FlagSpec): ParsedArgs {
  const result: ParsedArgs = { positionals: [], flags: {} };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) result.positionals.push(value);
    else if (!spec[value]) throw usage(`unknown flag ${value}.`, `Valid flags: ${Object.keys(spec).join(", ") || "none"}.`);
    else if (spec[value] === "boolean") addFlag(result.flags, value, "true");
    else addFlag(result.flags, value, requireValue(args[++index], `${value} requires a value.`));
  }
  return result;
}

function addFlag(flags: Record<string, string[]>, name: string, value: string): void {
  (flags[name] ??= []).push(value);
}

function firstFlag(parsed: ParsedArgs | ExtractedGlobals, name: string): string | undefined {
  return parsed.flags[name]?.at(-1);
}

function hasFlag(parsed: ParsedArgs | ExtractedGlobals, name: string): boolean {
  return firstFlag(parsed, name) === "true";
}

function parseBlobIdentity(parsed: ParsedArgs): { id: string; title: string } {
  const mint = hasFlag(parsed, "--mint");
  requirePositionals(parsed, mint ? 1 : 2, mint ? "add --mint requires a title." : "add requires a blob ID and title.");
  const identity = mint
    ? { id: `blob-${randomUUID().slice(0, 8)}`, title: parsed.positionals[0] }
    : { id: parsed.positionals[0], title: parsed.positionals[1] };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(identity.id)) {
    throw usage("blob ID must use letters, numbers, dot, underscore, or dash.");
  }
  return identity;
}

function readBody(parsed: ParsedArgs): string {
  const body = firstFlag(parsed, "--body");
  const bodyFile = firstFlag(parsed, "--body-file");
  if (body && bodyFile) throw usage("Use either --body or --body-file, not both.");
  return bodyFile ? readFileSync(resolve(bodyFile), "utf8") : body ?? "";
}

function requireBlob(store: ConveyorStore, id: string): Blob {
  const blob = store.getBlob(id);
  if (!blob) throw new Error(`Blob ${id} was not found.`);
  return blob;
}

function requireFlag(parsed: ParsedArgs, name: string): string {
  return requireValue(firstFlag(parsed, name), `${name} is required.`);
}

function requirePositionals(parsed: ParsedArgs, count: number, message: string): void {
  if (parsed.positionals.length !== count) throw usage(message);
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw usage(`${name} must be a positive integer.`);
  return number;
}

function requireValue(value: string | undefined, message: string): string {
  if (!value || value.startsWith("--")) throw usage(message);
  return value;
}

function contentPreview(content: string, full: boolean): ContentPreview {
  if (full || content.length <= bodyLimit) return { text: content, truncated: false };
  return { text: `${content.slice(0, bodyLimit)}…`, truncated: true };
}

function blobSummary(blob: Blob): Record<string, unknown> {
  return { id: blob.id, title: blob.title, state: blob.state, paused: blob.paused };
}

function blobDetail(blob: Blob): Record<string, unknown> {
  return {
    id: blob.id,
    title: blob.title,
    state: blob.state,
    step: blob.state === "complete" ? null : blob.state,
    paused: blob.paused,
    pipelinePath: blob.pipelinePath,
    cwd: blob.cwd,
    lastCompletedStep: blob.lastCompletedStepId,
    forcedStep: blob.forcedStepId,
    updatedAt: blob.updatedAt,
  };
}

function receiptSummary(receipt: Receipt, full: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: receipt.id,
    blobId: receipt.blobId,
    step: receipt.stepId,
    attempt: receipt.attempt,
    status: receipt.status,
    valid: !receipt.invalidatedAt,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
  };
  if (full) Object.assign(base, {
    adapter: receipt.adapter,
    definitionGitSha: receipt.definitionGitSha,
    definitionHash: receipt.definitionHash,
    inputArtifacts: receipt.inputArtifacts,
    outputArtifacts: receipt.outputArtifacts,
    externalRunId: receipt.externalRunId,
    reason: receipt.reason,
    error: receipt.error,
    invalidatedAt: receipt.invalidatedAt,
  });
  return base;
}

function stateCounts(blobs: Blob[]): Record<string, number> {
  const states: Record<string, number> = {};
  for (const blob of blobs) states[blob.state] = (states[blob.state] ?? 0) + 1;
  return states;
}

function homeHelp(total: number, shown: number): string[] {
  const help = ["Run `axi-factorio add <id> \"<title>\" --pipeline <dir>` to add a blob."];
  if (total) help.unshift("Run `axi-factorio show <id>` for blob and receipt details.");
  if (total > shown) help.unshift(`Run \`axi-factorio list\` for all ${total} blobs.`);
  return help;
}

function displayPath(path: string): string {
  const absolutePath = resolve(path);
  return absolutePath.startsWith(homedir()) ? `~${absolutePath.slice(homedir().length)}` : absolutePath;
}

function defaultDatabasePath(): string {
  return process.env.AXI_FACTORIO_DB ?? join(process.cwd(), ".axi-factorio", "factorio.sqlite");
}

function serviceAbortController(): AbortController {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller;
}

function printVersion(): void {
  process.stdout.write("axi-factorio 0.1.0-rc.1\n");
}

function helpCommand(args: string[]): string | undefined {
  if (args[0] === "help") return args[1];
  const withoutHelp = args.filter((argument) => argument !== "--help");
  return extractGlobals(withoutHelp).args[0];
}

function showCommandHelp(command?: string): void {
  const text = helpText[command ?? "root"];
  if (!text) throw usage(`unknown command ${command}.`, helpText.root);
  process.stdout.write(text);
}

function usage(message: string, help?: string): UsageError {
  return new UsageError(message, help);
}

class UsageError extends Error {
  readonly help?: string;

  constructor(message: string, help?: string) {
    super(message);
    this.help = help;
  }
}

type FlagKind = "boolean" | "value";
type FlagSpec = Record<string, FlagKind>;
type ParsedArgs = { positionals: string[]; flags: Record<string, string[]> };
type ExtractedGlobals = { flags: Record<string, string[]>; args: string[] };
type GlobalOptions = { databasePath: string; json: boolean; args: string[] };
type ContentPreview = { text: string; truncated: boolean };

const bodyLimit = 800;
const addFlags: FlagSpec = {
  "--pipeline": "value",
  "--cwd": "value",
  "--body": "value",
  "--body-file": "value",
  "--input-ref": "value",
  "--mint": "boolean",
};

const helpText: Record<string, string> = {
  root: `axi-factorio 0.1.0-rc.1

Usage: axi-factorio <command> [flags]
Commands: add, list, status, show, receipts, retry, rewind, kick, run, service, workbench, init
Globals: --db PATH, --json, --help, --version

Run without arguments for the live conveyor dashboard.
`,
  add: `Usage: axi-factorio add BLOB_ID "TITLE" --pipeline DIR [--cwd DIR] [--body TEXT|--body-file PATH] [--input-ref REF...]
       axi-factorio add --mint "TITLE" --pipeline DIR
`,
  list: `Usage: axi-factorio list [--state STATE] [--limit 50]\n`,
  status: `Usage: axi-factorio status [--state STATE] [--limit 50]\n`,
  show: `Usage: axi-factorio show BLOB_ID [--full]\n`,
  receipts: `Usage: axi-factorio receipts [BLOB_ID] [--limit 50] [--full]\n`,
  retry: `Usage: axi-factorio retry BLOB_ID\n`,
  rewind: `Usage: axi-factorio rewind BLOB_ID STEP_ID\n`,
  kick: `Usage: axi-factorio kick BLOB_ID STEP_ID\n`,
  run: `Usage: axi-factorio run\n`,
  evaluate: `Usage: axi-factorio evaluate\n`,
  service: `Usage: axi-factorio service [--poll-ms 1000]\n`,
  workbench: `Usage: axi-factorio workbench [--db PATH] [--port 4317]\n`,
  init: `Usage: axi-factorio init\n`,
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const help = error instanceof UsageError && error.help ? [error.help] : [];
  printOutput({ error: message, help }, process.argv.includes("--json"));
  log("command_failed", { error: message, usage: error instanceof UsageError });
  process.exitCode = error instanceof UsageError ? 2 : 1;
});

import type { Receipt, Blob } from "./Types.ts";
import { CodexAdapter } from "./CodexAdapter.ts";
import { FactorioDatabase } from "./Database.ts";
import { ConveyorStore } from "./Store.ts";
import { log } from "./Logger.ts";
import { printOutput } from "./Output.ts";
import { discoverPipeline, nextStep, requireStep, snapshotDefinition } from "./Pipeline.ts";
import { ConveyorRunner } from "./Runner.ts";
import { ConveyorService } from "./Service.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
