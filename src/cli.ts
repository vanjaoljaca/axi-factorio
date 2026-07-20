#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--version") || args[0] === "version") return printVersion();
  if (args.includes("--help") || args[0] === "help") return showCommandHelp(helpCommand(args));
  const options = parseGlobalOptions(args);
  const databaseAlreadyExisted = existsSync(options.databasePath);
  const database = new FactorioDatabase(options.databasePath);
  const store = new ConveyorStore(database);
  try {
    await runCommand(options.args, store, options.json, databaseAlreadyExisted, options.databasePath);
  } finally {
    database.close();
  }
}

async function runCommand(
  args: string[],
  store: ConveyorStore,
  json: boolean,
  databaseAlreadyExisted: boolean,
  databasePath: string,
): Promise<void> {
  switch (args[0]) {
    case undefined: return showHome(store, json);
    case "init": return initialize(args.slice(1), json, databaseAlreadyExisted);
    case "project": return runProject(args.slice(1), store, json);
    case "add": return addBlob(args.slice(1), store, json);
    case "list":
    case "status": return listBlobs(args.slice(1), store, json);
    case "show": return showBlob(args.slice(1), store, json);
    case "receipts": return showReceipts(args.slice(1), store, json);
    case "play":
    case "step":
    case "stop": return controlBlob(args.slice(1), store, json, args[0]);
    case "retry": return retryBlob(args.slice(1), store, json);
    case "review": return armHumanReview(args.slice(1), store, json);
    case "feedback": return addHumanFeedback(args.slice(1), store, json);
    case "approve": return approveHumanReview(args.slice(1), store, json);
    case "adopt": return adoptBlob(args.slice(1), store, json);
    case "rewind":
    case "kick": return rewindBlob(args.slice(1), store, json, args[0]);
    case "run":
    case "evaluate": return runOne(args.slice(1), store, json);
    case "service": return runService(args.slice(1), store, json, databasePath);
    default: throw usage(`unknown command ${args[0]}`, "Run `axi-factorio --help`.");
  }
}

function showHome(store: ConveyorStore, json: boolean): void {
  const blobs = store.listBlobs();
  const active = blobs.filter((blob) => blob.state !== "complete").slice(0, 10);
  printOutput({
    bin: displayPath(process.argv[1]),
    description: "Move blobs down Git-defined steps with SQLite receipts.",
    projects: store.listProjects().map(projectSummary),
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
  const requestedCwd = resolve(firstFlag(parsed, "--cwd") ?? process.cwd());
  const projectId = firstFlag(parsed, "--project") ?? defaultProjectId(requestedCwd);
  const project = store.getProject(projectId) ?? store.createProject(projectId, {
    name: basename(requestedCwd),
    root: requestedCwd,
    pipelineRoot: resolve(firstFlag(parsed, "--pipeline-root") ?? join(requestedCwd, "pipelines")),
    defaultPipeline: firstFlag(parsed, "--pipeline") ?? "default",
  }).project;
  const cwd = resolve(firstFlag(parsed, "--cwd") ?? project.root);
  const pipelineRoot = resolve(firstFlag(parsed, "--pipeline-root") ?? project.pipelineRoot);
  const pipeline = resolvePipeline(firstFlag(parsed, "--pipeline") ?? project.defaultPipeline, pipelineRoot);
  const pipelinePath = pipeline.path;
  const steps = discoverPipeline(pipelinePath);
  snapshotDefinition(steps[0], pipelinePath);
  const result = store.createBlob(identity.id, {
    title: identity.title,
    body: readBody(parsed),
    cwd,
    projectId: project.id,
    pipelineId: pipeline.id,
    pipelinePath,
    inputArtifacts: parsed.flags["--input-ref"] ?? [],
  });
  printOutput({
    ok: `add ${result.blob.id} -> ${result.blob.state}`,
    already: result.already,
    blob: blobSummary(result.blob),
    help: [`Run \`axi-factorio play ${result.blob.id}\` to start it.`],
  }, json);
}

function runProject(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, {
    "--root": "value", "--pipeline-root": "value", "--cwd": "value", "--pipeline": "value",
  });
  const action = parsed.positionals[0] ?? "list";
  if (action === "list") return listProjects(parsed, store, json);
  if (action === "show") return showProject(parsed, store, json);
  if (action === "add" || action === "upsert") return addProject(parsed, store, json, action);
  throw usage("project accepts list, show, add, or upsert.");
}

function listProjects(parsed: ParsedArgs, store: ConveyorStore, json: boolean): void {
  requirePositionals(parsed, parsed.positionals.length ? 1 : 0, "project list accepts no IDs.");
  const projects = store.listProjects();
  printOutput({ count: projects.length, projects: projects.map(projectSummary), help: projectHelp(projects.length) }, json);
}

function showProject(parsed: ParsedArgs, store: ConveyorStore, json: boolean): void {
  requirePositionals(parsed, 2, "project show requires one project ID.");
  const project = requireProject(store, parsed.positionals[1]);
  printOutput({
    project: projectSummary(project),
    help: [`Run \`axi-factorio add <id> "<title>" --project ${project.id}\`.`],
  }, json);
}

function addProject(
  parsed: ParsedArgs,
  store: ConveyorStore,
  json: boolean,
  action: "add" | "upsert",
): void {
  requirePositionals(parsed, 3, "project add requires an ID and name.");
  const id = validId(parsed.positionals[1], "project");
  const root = resolve(firstFlag(parsed, "--root") ?? firstFlag(parsed, "--cwd") ?? process.cwd());
  const input = {
    name: parsed.positionals[2],
    root,
    pipelineRoot: resolve(firstFlag(parsed, "--pipeline-root") ?? join(root, "pipelines")),
    defaultPipeline: firstFlag(parsed, "--pipeline") ?? "default",
  };
  const result = action === "upsert"
    ? store.upsertProject(id, input)
    : store.createProject(id, input);
  printOutput({
    ok: `project ${action} ${id}`, already: result.already, project: projectSummary(result.project),
    help: [`Run \`axi-factorio add <id> "<title>" --project ${id}\`.`],
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
      : ["Run `axi-factorio add <id> \"<title>\"`."],
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
    humanInputs: store.listHumanInputs(blob.id),
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

function controlBlob(
  args: string[],
  store: ConveyorStore,
  json: boolean,
  action: "play" | "step" | "stop",
): void {
  const parsed = parseArgs(args, {});
  requirePositionals(parsed, 1, `${action} requires one blob ID.`);
  const id = parsed.positionals[0];
  const result = action === "play"
    ? store.requestContinuous(id)
    : action === "step"
      ? store.requestStep(id)
      : store.requestStop(id);
  printOutput({
    ok: `${action} ${id} -> ${result.blob.runRequested ? result.blob.executionMode : "stopped"}`,
    already: result.already,
    blob: blobSummary(result.blob),
  }, json);
}

function armHumanReview(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--note": "value" });
  requirePositionals(parsed, 1, "review requires one blob ID.");
  const input = store.armHumanGate(parsed.positionals[0], firstFlag(parsed, "--note") ?? "");
  printOutput({ ok: `review ${input.blobId} -> ${input.stepId}`, humanInput: input }, json);
}

function addHumanFeedback(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--evidence": "value" });
  requirePositionals(parsed, 2, "feedback requires a blob ID and feedback text.");
  const input = store.addHumanFeedback(
    parsed.positionals[0], parsed.positionals[1], parsed.flags["--evidence"] ?? [],
  );
  printOutput({ ok: `feedback ${input.blobId} -> ${input.stepId}`, humanInput: input }, json);
}

function approveHumanReview(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--note": "value", "--evidence": "value" });
  requirePositionals(parsed, 1, "approve requires one blob ID.");
  const input = store.approveHumanGate(
    parsed.positionals[0], firstFlag(parsed, "--note") ?? "", parsed.flags["--evidence"] ?? [],
  );
  printOutput({ ok: `approve ${input.blobId} -> ${input.stepId}`, humanInput: input }, json);
}

function adoptBlob(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--source": "value", "--evidence": "value" });
  requirePositionals(parsed, 2, "adopt requires a blob ID and current step ID.");
  const blob = requireBlob(store, parsed.positionals[0]);
  const steps = discoverPipeline(blob.pipelinePath);
  const target = requireStep(steps, parsed.positionals[1]);
  const evidence = adoptionEvidence(parsed.flags["--evidence"] ?? [], steps, target);
  const attestations = steps.slice(0, steps.indexOf(target)).map((step) => ({
    step, definition: snapshotDefinition(step, blob.pipelinePath), evidence: evidence.get(step.id) ?? [],
  }));
  const adopted = store.adoptBlob(blob.id, target, steps, requireFlag(parsed, "--source"), attestations);
  printOutput({ ok: `adopt ${blob.id} -> ${target.id}`, blob: blobSummary(adopted) }, json);
}

function adoptionEvidence(values: string[], steps: StepDefinition[], target: StepDefinition): Map<string, string[]> {
  const prior = new Set(steps.slice(0, steps.indexOf(target)).map((step) => step.id));
  const result = new Map<string, string[]>();
  for (const value of values) {
    const split = value.indexOf("=");
    if (split < 1 || split === value.length - 1) throw usage("--evidence must use STEP_ID=REF.");
    const stepId = value.slice(0, split);
    if (!prior.has(stepId)) throw usage(`Evidence step ${stepId} is not prior to ${target.id}.`);
    result.set(stepId, [...(result.get(stepId) ?? []), value.slice(split + 1)]);
  }
  return result;
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
    help: [`Run \`axi-factorio play ${blob.id}\` to move the blob forward again.`],
  }, json);
}

async function runOne(args: string[], store: ConveyorStore, json: boolean): Promise<void> {
  const parsed = parseArgs(args, harnessFlags);
  requirePositionals(parsed, 0, "run accepts no positional arguments.");
  const runner = await configuredRunner(store, parsed);
  const processed = await new ConveyorService(store, runner).runOnce(serviceAbortController().signal);
  printOutput({
    run: processed ? "processed" : "idle",
    help: processed ? ["Run `axi-factorio` to inspect live state."] : [],
  }, json);
}

async function runService(
  args: string[],
  store: ConveyorStore,
  json: boolean,
  databasePath: string,
): Promise<void> {
  const parsed = parseArgs(args, {
    "--poll-ms": "value", "--port": "value", ...harnessFlags,
  });
  const action = parsed.positionals[0] ?? "run";
  if (action === "install") {
    return printService("installed", installService(
      databasePath,
      servicePort(parsed),
      harnessSelector(parsed),
      instrumentationSelector(parsed),
    ), json);
  }
  if (action === "status") return printService("status", showServiceStatus(), json);
  if (action === "uninstall") return printService("uninstalled", uninstallService(), json);
  if (action !== "run") throw usage("service accepts run, install, status, or uninstall.");
  process.title = "axi-factorio-service";
  requirePositionals(
    parsed,
    parsed.positionals.length ? 1 : 0,
    "service run accepts no additional positional arguments.",
  );
  const pollMs = positiveInteger(firstFlag(parsed, "--poll-ms") ?? "1000", "--poll-ms");
  if (pollMs < 50) throw usage("--poll-ms must be at least 50.");
  const controller = serviceAbortController();
  const viewer = startServiceViewer(databasePath, servicePort(parsed), controller);
  const runner = await configuredRunner(store, parsed);
  await Promise.all([new ConveyorService(store, runner, pollMs).run(controller.signal), viewer]);
  printOutput({ ok: "service -> stopped" }, json);
}

async function configuredRunner(store: ConveyorStore, parsed: ParsedArgs): Promise<ConveyorRunner> {
  const harness = await loadHarness(harnessSelector(parsed));
  const instrumentation = await loadHarnessInstrumentation(instrumentationSelector(parsed));
  return new ConveyorRunner(store, harness, instrumentation);
}

function harnessSelector(parsed: ParsedArgs): string {
  return firstFlag(parsed, "--harness") ?? defaultHarnessSelector();
}

function instrumentationSelector(parsed: ParsedArgs): string {
  return firstFlag(parsed, "--instrumentation")
    ?? process.env.AXI_FACTORIO_INSTRUMENTATION
    ?? "none";
}

function printService(action: string, service: ServiceStatus, json: boolean): void {
  const help = action === "uninstalled"
    ? ["Run `axi-factorio service install` to install it again."]
    : ["Open the service URL or run `axi-factorio` to inspect conveyor state."];
  printOutput({ ok: `service -> ${action}`, service, help }, json);
}

function servicePort(parsed: ParsedArgs): number {
  return positiveInteger(firstFlag(parsed, "--port") ?? "4317", "--port");
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
  validId(identity.id, "blob");
  return identity;
}

function validId(id: string, kind: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw usage(`${kind} ID must use letters, numbers, dot, underscore, or dash.`);
  }
  return id;
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

function requireProject(store: ConveyorStore, id: string): Project {
  const project = store.getProject(id);
  if (!project) throw new Error(`Project ${id} was not found.`);
  return project;
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
  return {
    id: blob.id,
    title: blob.title,
    project: blob.projectId,
    state: blob.state,
    executionMode: blob.executionMode,
    runRequested: blob.runRequested,
  };
}

function blobDetail(blob: Blob): Record<string, unknown> {
  return {
    id: blob.id,
    title: blob.title,
    state: blob.state,
    step: blob.state === "complete" ? null : blob.state,
    paused: blob.paused,
    executionMode: blob.executionMode,
    runRequested: blob.runRequested,
    project: blob.projectId,
    pipeline: blob.pipelineId,
    pipelinePath: blob.pipelinePath,
    cwd: blob.cwd,
    lastCompletedStep: blob.lastCompletedStepId,
    forcedStep: blob.forcedStepId,
    humanGateStep: blob.humanGateStepId,
    humanGateApproved: Boolean(blob.humanGateApprovalInputId),
    updatedAt: blob.updatedAt,
  };
}

function projectSummary(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    pipelineRoot: project.pipelineRoot,
    defaultPipeline: project.defaultPipeline,
    ...resolvedProjectPipeline(project),
  };
}

function resolvedProjectPipeline(project: Project): Record<string, unknown> {
  try {
    const pipeline = resolvePipeline(project.defaultPipeline, project.pipelineRoot);
    return { resolvedPipeline: pipeline.id, resolvedPipelinePath: pipeline.path };
  } catch (error) {
    return {
      resolvedPipeline: null,
      resolvedPipelinePath: null,
      pipelineError: error instanceof Error ? error.message : String(error),
    };
  }
}

function projectHelp(count: number): string[] {
  return count
    ? ["Run `axi-factorio project show <id>` for project defaults."]
    : ["Run `axi-factorio project add <id> \"<name>\"`."];
}

function receiptSummary(receipt: Receipt, full: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: receipt.id,
    blobId: receipt.blobId,
    step: receipt.stepId,
    attempt: receipt.attempt,
    status: receipt.status,
    executionKind: receipt.executionKind,
    valid: !receipt.invalidatedAt,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
  };
  if (full) Object.assign(base, {
    adapter: receipt.adapter,
    attestationSource: receipt.attestationSource,
    attestationEvidence: receipt.attestationEvidence,
    definitionGitSha: receipt.definitionGitSha,
    definitionHash: receipt.definitionHash,
    inputArtifacts: receipt.inputArtifacts,
    outputArtifacts: receipt.outputArtifacts,
    externalRunId: receipt.externalRunId,
    continuationThreadId: receipt.continuationThreadId,
    humanInputs: receipt.humanInputs,
    approvalEvidence: receipt.approvalEvidence,
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
  const help = ["Run `axi-factorio add <id> \"<title>\"` to add a blob."];
  if (total) help.unshift("Run `axi-factorio show <id>` for blob and receipt details.");
  if (total > shown) help.unshift(`Run \`axi-factorio list\` for all ${total} blobs.`);
  return help;
}

function displayPath(path: string): string {
  const absolutePath = resolve(path);
  return absolutePath.startsWith(homedir()) ? `~${absolutePath.slice(homedir().length)}` : absolutePath;
}

function defaultDatabasePath(): string {
  return process.env.AXI_FACTORIO_DB ?? join(process.cwd(), "pipelines", "axi-factorio.db");
}

function defaultProjectId(cwd: string): string {
  return basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "default";
}

function resolvePipeline(selector = "default", root = join(process.cwd(), "pipelines")): PipelineSelection {
  const direct = resolve(selector);
  if (isDirectory(direct)) return { id: pipelineId(root, direct), path: direct };
  const selected = join(root, selector);
  if (isDirectory(selected) && /^v\d+$/.test(basename(selected))) {
    return { id: pipelineId(root, selected), path: selected };
  }
  const path = latestPipelineVersion(selected);
  return { id: pipelineId(root, path), path };
}

function latestPipelineVersion(pipelineRoot: string): string {
  if (!isDirectory(pipelineRoot)) throw new Error(`Pipeline ${pipelineRoot} was not found.`);
  const versions = readdirSync(pipelineRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
    .sort((left, right) => Number(right.name.slice(1)) - Number(left.name.slice(1)));
  if (!versions[0]) throw new Error(`Pipeline ${pipelineRoot} has no vN versions.`);
  return join(pipelineRoot, versions[0].name);
}

function pipelineId(root: string, path: string): string {
  const identity = relative(root, path);
  return identity.startsWith("..") ? path : identity.split(sep).join("/");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function serviceAbortController(): AbortController {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller;
}

function printVersion(): void {
  process.stdout.write("axi-factorio 0.1.0-rc.10\n");
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
type PipelineSelection = { id: string; path: string };

const bodyLimit = 800;
const addFlags: FlagSpec = {
  "--project": "value",
  "--pipeline": "value",
  "--pipeline-root": "value",
  "--cwd": "value",
  "--body": "value",
  "--body-file": "value",
  "--input-ref": "value",
  "--mint": "boolean",
};
const harnessFlags: FlagSpec = {
  "--harness": "value",
  "--instrumentation": "value",
};

const helpText: Record<string, string> = {
  root: `axi-factorio 0.1.0-rc.10

Usage: axi-factorio <command> [flags]
Commands: project, add, adopt, list, status, show, receipts, play, step, stop, retry, review, feedback, approve, rewind, kick, run, service, init
Globals: --db PATH, --json, --help, --version

Run without arguments for the live conveyor dashboard.
`,
  project: `Usage: axi-factorio project [list]
       axi-factorio project add PROJECT_ID "NAME" --root DIR --pipeline-root DIR [--pipeline NAME]
       axi-factorio project upsert PROJECT_ID "NAME" --root DIR --pipeline-root DIR [--pipeline NAME]
       axi-factorio project show PROJECT_ID
`,
  add: `Usage: axi-factorio add BLOB_ID "TITLE" [--project ID] [--pipeline NAME|NAME/vN|DIR] [--pipeline-root DIR] [--cwd DIR] [--body TEXT|--body-file PATH] [--input-ref REF...]
       axi-factorio add --mint "TITLE" [--pipeline NAME|NAME/vN|DIR]
`,
  list: `Usage: axi-factorio list [--state STATE] [--limit 50]\n`,
  status: `Usage: axi-factorio status [--state STATE] [--limit 50]\n`,
  show: `Usage: axi-factorio show BLOB_ID [--full]\n`,
  receipts: `Usage: axi-factorio receipts [BLOB_ID] [--limit 50] [--full]\n`,
  play: `Usage: axi-factorio play BLOB_ID\n`,
  step: `Usage: axi-factorio step BLOB_ID\n`,
  stop: `Usage: axi-factorio stop BLOB_ID\n`,
  retry: `Usage: axi-factorio retry BLOB_ID\n`,
  review: `Usage: axi-factorio review BLOB_ID [--note TEXT]\n`,
  feedback: `Usage: axi-factorio feedback BLOB_ID "TEXT" [--evidence REF...]\n`,
  approve: `Usage: axi-factorio approve BLOB_ID --evidence REF... [--note TEXT]\n`,
  adopt: `Usage: axi-factorio adopt BLOB_ID CURRENT_STEP --source KIND:EXACT_ID --evidence STEP_ID=REF...\n`,
  rewind: `Usage: axi-factorio rewind BLOB_ID STEP_ID\n`,
  kick: `Usage: axi-factorio kick BLOB_ID STEP_ID\n`,
  run: `Usage: axi-factorio run [--harness codex|module:SPECIFIER[#EXPORT]] [--instrumentation module:SPECIFIER[#EXPORT]]\n`,
  evaluate: `Usage: axi-factorio evaluate [--harness codex|module:SPECIFIER[#EXPORT]] [--instrumentation module:SPECIFIER[#EXPORT]]\n`,
  service: `Usage: axi-factorio service [run|install|status|uninstall] [--poll-ms 1000] [--port 4317] [--harness codex|module:SPECIFIER[#EXPORT]] [--instrumentation module:SPECIFIER[#EXPORT]]\n`,
  init: `Usage: axi-factorio init\n`,
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const help = error instanceof UsageError && error.help ? [error.help] : [];
  printOutput({ error: message, help }, process.argv.includes("--json"));
  log("command_failed", { error: message, usage: error instanceof UsageError });
  process.exitCode = error instanceof UsageError ? 2 : 1;
});

import type { Receipt, Blob, Project, StepDefinition } from "./Types.ts";
import { FactorioDatabase } from "./Database.ts";
import {
  defaultHarnessSelector,
  loadHarness,
  loadHarnessInstrumentation,
} from "./HarnessLoader.ts";
import { ConveyorStore } from "./Store.ts";
import { log } from "./Logger.ts";
import { printOutput } from "./Output.ts";
import { discoverPipeline, nextStep, requireStep, snapshotDefinition } from "./Pipeline.ts";
import { ConveyorRunner } from "./Runner.ts";
import { ConveyorService } from "./Service.ts";
import {
  type ServiceStatus,
  installService,
  showServiceStatus,
  startServiceViewer,
  uninstallService,
} from "./ServiceInstall.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
