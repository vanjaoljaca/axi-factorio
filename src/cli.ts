#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--version") || args.includes("-v") || args[0] === "version") return printVersion();
  if (args.includes("--help") || args[0] === "help") return showCommandHelp(helpCommand(args));
  const options = parseGlobalOptions(args);
  if (options.args[0] === "setup") return setupAxi(options.args.slice(1), options.json);
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
    case "artifact": return runArtifact(args.slice(1), store, json);
    case "review": return armHumanReview(args.slice(1), store, json);
    case "feedback": return addHumanFeedback(args.slice(1), store, json);
    case "approve": return approveHumanReview(args.slice(1), store, json);
    case "reset-endpoint": return resetLocalEndpoint(args.slice(1), store, json);
    case "rebind-endpoint": return rebindLocalEndpoint(args.slice(1), store, json);
    case "adopt": return adoptBlob(args.slice(1), store, json);
    case "relocate": return relocateBlob(args.slice(1), store, json);
    case "bind-execution": return bindExecutionWorkspace(args.slice(1), store, json);
    case "rewind":
    case "kick": return rewindBlob(args.slice(1), store, json, args[0]);
    case "run":
    case "evaluate": return runOne(args.slice(1), store, json);
    case "service": return runService(args.slice(1), store, json, databasePath);
    default: throw usage(`unknown command ${args[0]}`, "Run `axi-factorio --help`.");
  }
}

async function runArtifact(args: string[], store: ConveyorStore, json: boolean): Promise<void> {
  const action = args[0];
  if (action !== "verify") throw usage("artifact accepts verify.");
  const parsed = parseArgs(args.slice(1), {});
  requirePositionals(parsed, 1, "artifact verify requires one blob ID.");
  const id = parsed.positionals[0];
  const blob = store.getBlob(id);
  if (!blob) throw new Error(`Blob ${id} was not found.`);
  const step = nextStep(blob, discoverPipeline(blob.pipelinePath));
  if (!step) throw new Error(`Blob ${id} is complete.`);
  const verification = verifyArtifacts(snapshotDefinition(step, blob.pipelinePath).exit, blob.executionWorkspaceRoot);
  if (verification.policy.kind !== "artifacts") throw new Error(`Step ${step.id} declares no local artifact links.`);
  if (blob.paused) store.retryBlob(id, true);
  else store.requestStep(id);
  await new ConveyorRunner(store, new ArtifactPresenceHarness()).runBlob(id);
  const receipt = store.listReceipts(id).at(-1);
  printOutput({ ok: `artifact verify ${id} -> ${receipt?.status}`, verification, receipt }, json);
}

function showHome(store: ConveyorStore, json: boolean): void {
  const projects = directoryProjects(store.listProjects(), process.cwd());
  const projectIds = new Set(projects.map((project) => project.id));
  const blobs = store.listBlobs().filter((blob) => projectIds.has(blob.projectId));
  const active = blobs.filter((blob) => blob.state !== "complete").slice(0, 10);
  printOutput({
    bin: displayPath(process.argv[1]),
    description: axiDescription,
    count: `${active.length} of ${blobs.length} total`,
    projects: projects.slice(0, 10).map((project) => projectSummary(project)),
    summary: stateCounts(blobs),
    blobs: active.map(blobSummary),
    done: `${blobs.filter((blob) => blob.state === "complete").length} retained`,
    help: homeHelp(blobs.length, active.length),
  }, json);
}

function setupAxi(args: string[], json: boolean): void {
  const parsed = parseArgs(args, {});
  requirePositionals(parsed, 1, "setup requires `hooks`.");
  if (parsed.positionals[0] !== "hooks") throw usage("setup accepts only `hooks`.");
  printOutput(installAxiFactorioHooks(), json);
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

function relocateBlob(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--root": "value", "--evidence": "value" });
  requirePositionals(parsed, 1, "relocate requires one blob ID.");
  const root = firstFlag(parsed, "--root");
  const evidence = parsed.flags["--evidence"] ?? [];
  if (!root) throw usage("relocate requires --root DIR.");
  const relocation = store.relocateBlobWorkspace(parsed.positionals[0], resolve(root), evidence);
  printOutput({
    ok: `relocate ${relocation.blobId} -> ${relocation.newCwd}`,
    relocation,
    blob: blobSummary(store.getBlob(relocation.blobId)!),
    project: projectSummary(store.getProject(relocation.projectId)!),
  }, json);
}

function bindExecutionWorkspace(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--root": "value", "--evidence": "value" });
  requirePositionals(parsed, 1, "bind-execution requires one blob ID.");
  const root = firstFlag(parsed, "--root");
  if (!root) throw usage("bind-execution requires --root DIR.");
  const binding = store.bindExecutionWorkspace(
    parsed.positionals[0], resolve(root), parsed.flags["--evidence"] ?? [],
  );
  printOutput({
    ok: `bind-execution ${binding.blobId} -> ${binding.newExecutionWorkspaceRoot}`,
    binding,
    blob: blobDetail(store.getBlob(binding.blobId)!),
  }, json);
}

function runProject(args: string[], store: ConveyorStore, json: boolean): void {
  const action = args[0] ?? "list";
  const commandArgs = args[0] ? args.slice(1) : [];
  if (action === "list") return listProjects(parseArgs(commandArgs, { "--fields": "value" }), store, json);
  if (action === "show") return showProject(parseArgs(commandArgs, {}), store, json);
  if (action === "add" || action === "upsert") return addProject(parseArgs(commandArgs, {
    "--root": "value", "--pipeline-root": "value", "--cwd": "value", "--pipeline": "value",
  }), store, json, action);
  if (action === "remove") return removeProject(parseArgs(commandArgs, {
    "--confirm": "value", "--evidence": "value",
  }), store, json);
  throw usage("project accepts list, show, add, upsert, or remove.");
}

function removeProject(parsed: ParsedArgs, store: ConveyorStore, json: boolean): void {
  requirePositionals(parsed, 1, "project remove requires one project ID.");
  const id = validId(parsed.positionals[0], "project");
  const preview = store.previewProjectRemoval(id);
  const confirmation = firstFlag(parsed, "--confirm");
  if (!confirmation) return printOutput({
    preview,
    help: [`Re-run with \`--confirm ${id} --evidence <reference>\` to remove this exact project graph.`],
  }, json);
  const result = store.removeProject(id, confirmation, parsed.flags["--evidence"] ?? []);
  printOutput({ ok: `project remove ${id}`, removal: result }, json);
}

function listProjects(parsed: ParsedArgs, store: ConveyorStore, json: boolean): void {
  requirePositionals(parsed, 0, "project list accepts no IDs.");
  const projects = store.listProjects();
  const fields = requestedFields(parsed, projectDefaultFields, projectFields);
  printOutput({
    count: projects.length,
    projects: projects.map((project) => projectSummary(project, fields)),
    empty: projects.length ? undefined : "0 projects found in this workspace.",
    help: projectHelp(projects.length),
  }, json);
}

function showProject(parsed: ParsedArgs, store: ConveyorStore, json: boolean): void {
  requirePositionals(parsed, 1, "project show requires one project ID.");
  const project = requireProject(store, parsed.positionals[0]);
  printOutput({ project: projectDetail(project) }, json);
}

function addProject(
  parsed: ParsedArgs,
  store: ConveyorStore,
  json: boolean,
  action: "add" | "upsert",
): void {
  requirePositionals(parsed, 2, "project add requires an ID and name.");
  const id = validId(parsed.positionals[0], "project");
  const root = resolve(firstFlag(parsed, "--root") ?? firstFlag(parsed, "--cwd") ?? process.cwd());
  const input = {
    name: parsed.positionals[1],
    root,
    pipelineRoot: resolve(firstFlag(parsed, "--pipeline-root") ?? join(root, "pipelines")),
    defaultPipeline: firstFlag(parsed, "--pipeline") ?? "default",
  };
  const result = action === "upsert"
    ? store.upsertProject(id, input)
    : store.createProject(id, input);
  printOutput({
    ok: `project ${action} ${id}`, already: result.already, project: projectDetail(result.project),
    help: [`Run \`axi-factorio add <id> "<title>" --project ${id}\`.`],
  }, json);
}

function listBlobs(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--state": "value", "--limit": "value", "--fields": "value" });
  requirePositionals(parsed, 0, "list accepts no positional arguments.");
  const state = firstFlag(parsed, "--state");
  const limit = positiveInteger(firstFlag(parsed, "--limit") ?? "50", "--limit");
  const all = store.listBlobs().filter((blob) => !state || blob.state === state);
  const fields = requestedFields(parsed, blobDefaultFields, blobFields);
  printOutput({
    count: `${Math.min(all.length, limit)} of ${all.length} total`,
    blobs: all.slice(0, limit).map((blob) => blobSummary(blob, fields)),
    empty: all.length ? undefined : `0 blobs found${state ? ` in state ${state}` : " in this workspace"}.`,
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
  const parsed = parseArgs(args, { "--limit": "value", "--full": "boolean", "--fields": "value" });
  if (parsed.positionals.length > 1) throw usage("receipts accepts at most one blob ID.");
  const limit = positiveInteger(firstFlag(parsed, "--limit") ?? "50", "--limit");
  const all = store.listReceipts(parsed.positionals[0]);
  const full = hasFlag(parsed, "--full");
  const fields = requestedFields(parsed, receiptDefaultFields, receiptFields);
  printOutput({
    count: `${Math.min(all.length, limit)} of ${all.length} total`,
    receipts: all.slice(-limit).map((receipt) => receiptSummary(receipt, full, fields)),
    empty: all.length ? undefined : "0 receipts found for this query.",
    help: full || !all.length ? [] : ["Run `axi-factorio receipts [<id>] --full` for hashes and artifacts."],
  }, json);
}

function retryBlob(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--once": "boolean" });
  requirePositionals(parsed, 1, "retry requires one blob ID.");
  const once = hasFlag(parsed, "--once");
  const result = store.retryBlob(parsed.positionals[0], once);
  printOutput({
    ok: `retry ${result.blob.id} -> ${result.blob.state}`,
    once,
    already: result.already,
  }, json);
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
  const parsed = parseArgs(args, {
    "--evidence": "value", "--no-run": "boolean", "--rerun": "value",
  });
  requirePositionals(parsed, 2, "feedback requires a blob ID and feedback text.");
  const schedule = !parsed.flags["--no-run"];
  const rerun = firstFlag(parsed, "--rerun");
  const blob = store.getBlob(parsed.positionals[0]);
  if (!blob) throw new Error(`Blob ${parsed.positionals[0]} was not found.`);
  const steps = discoverPipeline(blob.pipelinePath);
  const input = rerun
    ? store.addHumanFeedbackForRerun(
      blob.id, requireStep(steps, rerun), steps, parsed.positionals[1],
      parsed.flags["--evidence"] ?? [], schedule,
    )
    : store.addHumanFeedback(
      blob.id, parsed.positionals[1], parsed.flags["--evidence"] ?? [], schedule,
    );
  printOutput({
    ok: `feedback ${input.blobId} -> ${input.stepId}`,
    scheduled: schedule,
    humanInput: input,
  }, json);
}

function approveHumanReview(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, {
    "--note": "value", "--evidence": "value", "--no-run": "boolean",
  });
  requirePositionals(parsed, 1, "approve requires one blob ID.");
  const schedule = !parsed.flags["--no-run"];
  const input = store.approveHumanGate(
    parsed.positionals[0], firstFlag(parsed, "--note") ?? "",
    parsed.flags["--evidence"] ?? [], schedule,
  );
  printOutput({
    ok: `approve ${input.blobId} -> ${input.stepId}`,
    scheduled: schedule,
    humanInput: input,
  }, json);
}

function resetLocalEndpoint(args: string[], store: ConveyorStore, json: boolean): void {
  const parsed = parseArgs(args, { "--reason": "value" });
  requirePositionals(parsed, 1, "reset-endpoint requires one blob ID.");
  const leases = store.resetLocalEndpoint(
    parsed.positionals[0], firstFlag(parsed, "--reason") ?? "Local endpoint reset from CLI.",
  );
  printOutput({ ok: `reset-endpoint ${parsed.positionals[0]}`, localEndpointLeases: leases }, json);
}

async function rebindLocalEndpoint(args: string[], store: ConveyorStore, json: boolean): Promise<void> {
  const parsed = parseArgs(args, { "--workspace": "value", "--git-head": "value", "--evidence": "value" });
  requirePositionals(parsed, 1, "rebind-endpoint requires one lease ID.");
  const evidence = parsed.flags["--evidence"] ?? [];
  if (evidence.length === 0) throw usage("rebind-endpoint requires at least one --evidence value.");
  const workspace = await new LocalEndpointSupervisor().inspectWorkspace(
    requireFlag(parsed, "--workspace"), requireFlag(parsed, "--git-head"),
  );
  const lease = store.rebindLocalEndpoint(parsed.positionals[0], {
    workspaceRoot: workspace.root, gitHead: requireFlag(parsed, "--git-head"),
    command: workspace.command, args: workspace.args, healthPath: workspace.healthPath, evidence,
  });
  printOutput({ ok: `rebind-endpoint ${lease.id} -> ${lease.gitHead}`, localEndpointLease: lease }, json);
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
  const action = args[0] ?? "run";
  const commandArgs = args[0] ? args.slice(1) : [];
  const spec = action === "run"
    ? { "--poll-ms": "value", "--port": "value", ...harnessFlags } as FlagSpec
    : action === "install"
      ? { "--port": "value", ...harnessFlags } as FlagSpec
      : {};
  const parsed = parseArgs(commandArgs, spec);
  if (action === "install") {
    return printService("installed", installService(
      databasePath,
      servicePort(parsed),
      harnessSelector(parsed),
      instrumentationSelector(parsed),
    ), json);
  }
  if (action === "status") {
    requirePositionals(parsed, 0, "service status accepts no arguments.");
    return printService("status", showServiceStatus(), json);
  }
  if (action === "uninstall") {
    requirePositionals(parsed, 0, "service uninstall accepts no arguments.");
    return printService("uninstalled", uninstallService(), json);
  }
  if (action !== "run") throw usage("service accepts run, install, status, or uninstall.");
  process.title = "axi-factorio-service";
  requirePositionals(
    parsed, 0,
    "service run accepts no additional positional arguments.",
  );
  const pollMs = positiveInteger(firstFlag(parsed, "--poll-ms") ?? "1000", "--poll-ms");
  if (pollMs < 50) throw usage("--poll-ms must be at least 50.");
  const controller = serviceAbortController();
  const viewer = startServiceViewer(databasePath, servicePort(parsed), controller);
  const runner = await configuredRunner(store, parsed);
  const dispatcher = new ConveyorService(store, runner, pollMs).run(controller.signal);
  await runCoupledService(controller, dispatcher, viewer);
  printOutput({ ok: "service -> stopped" }, json);
}

async function configuredRunner(store: ConveyorStore, parsed: ParsedArgs): Promise<ConveyorRunner> {
  const harness = await loadHarness(harnessSelector(parsed));
  const instrumentation = await loadHarnessInstrumentation(instrumentationSelector(parsed));
  return new ConveyorRunner(store, harness, instrumentation, {}, new LocalEndpointSupervisor());
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
  return {
    text: `${content.slice(0, bodyLimit)}… (truncated, ${content.length} chars total — use --full)`,
    truncated: true,
  };
}

function blobSummary(blob: Blob, fields = blobDefaultFields): Record<string, unknown> {
  return selectFields({
    id: blob.id,
    title: blob.title,
    state: blob.state,
    project: blob.projectId,
    executionMode: blob.executionMode,
    runRequested: blob.runRequested,
    pipeline: blob.pipelineId,
    cwd: blob.cwd,
    executionWorkspaceRoot: blob.executionWorkspaceRoot,
    updatedAt: blob.updatedAt,
  }, fields);
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
    projectRoot: blob.cwd,
    executionWorkspaceRoot: blob.executionWorkspaceRoot,
    lastCompletedStep: blob.lastCompletedStepId,
    forcedStep: blob.forcedStepId,
    humanGateStep: blob.humanGateStepId,
    humanGateApproved: Boolean(blob.humanGateApprovalInputId),
    updatedAt: blob.updatedAt,
  };
}

function projectSummary(project: Project, fields = projectDefaultFields): Record<string, unknown> {
  return selectFields({
    id: project.id,
    name: project.name,
    defaultPipeline: project.defaultPipeline,
    ...resolvedProjectPipeline(project),
    root: project.root,
    pipelineRoot: project.pipelineRoot,
  }, fields);
}

function projectDetail(project: Project): Record<string, unknown> {
  return projectSummary(project, projectFields);
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

function receiptSummary(
  receipt: Receipt,
  full: boolean,
  fields = receiptDefaultFields,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: receipt.id,
    step: receipt.stepId,
    attempt: receipt.attempt,
    status: receipt.status,
    blobId: receipt.blobId,
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
  return full ? base : selectFields(base, fields);
}

function requestedFields(parsed: ParsedArgs, defaults: string[], available: string[]): string[] {
  const values = parsed.flags["--fields"] ?? [];
  if (!values.length) return defaults;
  const fields = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  for (const field of fields) {
    if (!available.includes(field)) {
      throw usage(`unknown field ${field}.`, `Available fields: ${available.join(", ")}.`);
    }
  }
  return [...new Set(fields)];
}

function selectFields(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function stateCounts(blobs: Blob[]): Record<string, number> {
  const states: Record<string, number> = {};
  for (const blob of blobs) states[blob.state] = (states[blob.state] ?? 0) + 1;
  return states;
}

function homeHelp(total: number, shown: number): string[] {
  const help = [axiHomeHelp[2]];
  if (total) help.unshift(axiHomeHelp[0]);
  if (total > shown) help.unshift(`Run \`axi-factorio list\` for all ${total} blobs.`);
  return help;
}

function displayPath(path: string): string {
  const absolutePath = resolve(path);
  return absolutePath.startsWith(homedir()) ? `~${absolutePath.slice(homedir().length)}` : absolutePath;
}

function defaultDatabasePath(): string {
  if (process.env.AXI_FACTORIO_DB) return process.env.AXI_FACTORIO_DB;
  let directory = resolve(process.cwd());
  while (true) {
    const candidate = join(directory, "pipelines", "axi-factorio.db");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return join(resolve(process.cwd()), "pipelines", "axi-factorio.db");
    directory = parent;
  }
}

function directoryProjects(projects: Project[], cwd: string): Project[] {
  const directory = canonicalPath(cwd);
  return projects.filter((project) => pathsOverlap(directory, canonicalPath(project.root)));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
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
  process.stdout.write("axi-factorio 0.1.0-rc.52\n");
}

function helpCommand(args: string[]): string | undefined {
  if (args[0] === "help") return args[1];
  const withoutHelp = args.filter((argument) => argument !== "--help");
  const command = extractGlobals(withoutHelp).args;
  if (["artifact", "project", "service"].includes(command[0] ?? "") && command[1]) {
    return `${command[0]}:${command[1]}`;
  }
  return command[0];
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

const blobDefaultFields = ["id", "title", "state", "project"];
const blobFields = [
  ...blobDefaultFields, "executionMode", "runRequested", "pipeline", "cwd",
  "executionWorkspaceRoot", "updatedAt",
];
const projectDefaultFields = ["id", "name", "defaultPipeline", "resolvedPipeline"];
const projectFields = [
  ...projectDefaultFields, "resolvedPipelinePath", "pipelineError", "root", "pipelineRoot",
];
const receiptDefaultFields = ["id", "step", "status", "attempt"];
const receiptFields = [
  ...receiptDefaultFields, "blobId", "executionKind", "valid", "startedAt", "finishedAt",
];

const helpText: Record<string, string> = {
  root: `axi-factorio 0.1.0-rc.52

Usage: axi-factorio <command> [flags]
Commands: project, artifact, add, adopt, relocate, bind-execution, list, status, show, receipts, play, step, stop, retry, review, feedback, approve, reset-endpoint, rebind-endpoint, rewind, kick, run, service, setup, init
Globals: --db PATH, --json, --help, -v, --version

Examples:
  axi-factorio
  axi-factorio list --fields id,title,state,project
  axi-factorio show <id>
`,
  project: commandHelp(
    "axi-factorio project <list|show|add|upsert|remove>",
    ["Use `axi-factorio project <action> --help` for action-specific flags."],
    ["axi-factorio project list", "axi-factorio project show <project-id>"],
  ),
  artifact: commandHelp(
    "axi-factorio artifact verify BLOB_ID",
    ["Verify local Markdown-linked artifacts for the current step without invoking an agent."],
    ["axi-factorio artifact verify <id>"],
  ),
  "artifact:verify": commandHelp("axi-factorio artifact verify BLOB_ID", [], [
    "axi-factorio artifact verify <id>",
  ]),
  "project:list": commandHelp(
    "axi-factorio project list [--fields FIELDS]",
    ["--fields FIELDS  Comma-separated fields (default: id,name,defaultPipeline,resolvedPipeline)"],
    ["axi-factorio project list", "axi-factorio project list --fields id,name,root,pipelineRoot"],
  ),
  "project:show": commandHelp("axi-factorio project show PROJECT_ID", [], [
    "axi-factorio project show multilingual", "axi-factorio project show <project-id> --json",
  ]),
  "project:add": projectMutationHelp("add"),
  "project:upsert": projectMutationHelp("upsert"),
  "project:remove": commandHelp(
    "axi-factorio project remove PROJECT_ID [--confirm PROJECT_ID --evidence REF...]",
    ["--confirm ID  Exact project ID confirmation", "--evidence REF  Repeatable removal evidence"],
    ["axi-factorio project remove <project-id>", "axi-factorio project remove <project-id> --confirm <project-id> --evidence <ref>"],
  ),
  add: commandHelp(
    "axi-factorio add BLOB_ID \"TITLE\" [flags]",
    ["--project ID", "--pipeline SELECTOR (default: project default)", "--cwd DIR (default: project root)", "--body TEXT | --body-file PATH", "--input-ref REF (repeatable)", "--mint"],
    ["axi-factorio add <id> \"<title>\"", "axi-factorio add --mint \"<title>\" --project <project-id>"],
  ),
  list: listHelp("list"),
  status: listHelp("status"),
  show: commandHelp("axi-factorio show BLOB_ID [--full]", ["--full  Disable body and receipt truncation"], [
    "axi-factorio show <id>", "axi-factorio show <id> --full",
  ]),
  receipts: commandHelp(
    "axi-factorio receipts [BLOB_ID] [flags]",
    ["--limit N (default: 50)", "--fields FIELDS (default: id,step,status,attempt)", "--full  Include all provenance fields"],
    ["axi-factorio receipts <id>", "axi-factorio receipts <id> --full"],
  ),
  play: simpleBlobHelp("play", "request continuous progression"),
  step: simpleBlobHelp("step", "request exactly one transition"),
  stop: simpleBlobHelp("stop", "clear pending execution"),
  retry: commandHelp("axi-factorio retry BLOB_ID [--once]", [
    "--once  Retry exactly one receipt without changing continuous preference",
  ], ["axi-factorio retry <id>", "axi-factorio retry <id> --once"]),
  review: commandHelp("axi-factorio review BLOB_ID [--note TEXT]", ["--note TEXT (default: empty)"], [
    "axi-factorio review <id>", "axi-factorio review <id> --note \"<note>\"",
  ]),
  feedback: commandHelp("axi-factorio feedback BLOB_ID \"TEXT\" [--evidence REF...] [--rerun PIP_ID] [--no-run]", ["--evidence REF (repeatable)", "--rerun PIP_ID (rewind an earlier work pip)", "--no-run (record without scheduling)"], [
    "axi-factorio feedback <id> \"<feedback>\" --rerun codex.explore --no-run",
  ]),
  approve: commandHelp("axi-factorio approve BLOB_ID --evidence REF... [--note TEXT] [--no-run]", ["--evidence REF (required, repeatable)", "--note TEXT (default: empty)", "--no-run (record without scheduling)"], [
    "axi-factorio approve <id> --evidence <ref>", "axi-factorio approve <id> --evidence <git-head-ref> --note \"<note>\" --no-run",
  ]),
  "reset-endpoint": commandHelp("axi-factorio reset-endpoint BLOB_ID [--reason TEXT]", ["--reason TEXT (default: Local endpoint reset from CLI.)"], [
    "axi-factorio reset-endpoint <id>", "axi-factorio reset-endpoint <id> --reason \"<reason>\"",
  ]),
  "rebind-endpoint": commandHelp("axi-factorio rebind-endpoint LEASE_ID --workspace DIR --git-head SHA --evidence REF...", ["--workspace DIR (required)", "--git-head SHA (required exact clean head)", "--evidence REF (required, repeatable)"], [
    "axi-factorio rebind-endpoint <lease-id> --workspace <dir> --git-head <sha> --evidence <ref>",
  ]),
  adopt: commandHelp("axi-factorio adopt BLOB_ID CURRENT_STEP --source KIND:EXACT_ID --evidence STEP_ID=REF...", ["--source IDENTITY (required)", "--evidence STEP_ID=REF (required per prior step)"], [
    "axi-factorio adopt <id> <step-id> --source git-sha:<sha> --evidence <prior-step>=<ref>",
    "axi-factorio show <id> --full",
  ]),
  relocate: rootEvidenceHelp("relocate"),
  "bind-execution": rootEvidenceHelp("bind-execution"),
  rewind: twoIdHelp("rewind"),
  kick: twoIdHelp("kick"),
  run: runnerHelp("run"),
  evaluate: runnerHelp("evaluate"),
  service: commandHelp("axi-factorio service <run|install|status|uninstall>", ["Use `axi-factorio service <action> --help` for action-specific flags."], [
    "axi-factorio service status", "axi-factorio service install --port 4317 --harness codex",
  ]),
  "service:run": commandHelp("axi-factorio service run [flags]", ["--poll-ms N (default: 1000)", "--port N (default: 4317)", "--harness SELECTOR (default: codex)", "--instrumentation SELECTOR (default: none)"], [
    "axi-factorio service run", "axi-factorio service run --poll-ms 1000 --port 4317",
  ]),
  "service:install": commandHelp("axi-factorio service install [flags]", ["--port N (default: 4317)", "--harness SELECTOR (default: codex)", "--instrumentation SELECTOR (default: none)"], [
    "axi-factorio service install", "axi-factorio service install --port 4317 --harness codex",
  ]),
  "service:status": commandHelp("axi-factorio service status", [], ["axi-factorio service status", "axi-factorio --json service status"]),
  "service:uninstall": commandHelp("axi-factorio service uninstall", [], ["axi-factorio service status", "axi-factorio service uninstall"]),
  setup: commandHelp("axi-factorio setup hooks", [], ["axi-factorio setup hooks", "axi-factorio setup hooks --json"]),
  init: commandHelp("axi-factorio init", [], ["axi-factorio init", "axi-factorio init --db <path>"]),
};

function commandHelp(usage: string, flags: string[], examples: string[]): string {
  const flagLines = flags.length ? flags.map((flag) => `  ${flag}`).join("\n") : "  none";
  return `Usage: ${usage}\n\nFlags:\n${flagLines}\n\nExamples:\n${examples.map((item) => `  ${item}`).join("\n")}\n`;
}

function listHelp(command: "list" | "status"): string {
  return commandHelp(`axi-factorio ${command} [flags]`, [
    "--state STATE", "--limit N (default: 50)",
    "--fields FIELDS (default: id,title,state,project)",
  ], [`axi-factorio ${command}`, `axi-factorio ${command} --state <state> --fields id,title,state`]);
}

function projectMutationHelp(action: "add" | "upsert"): string {
  return commandHelp(`axi-factorio project ${action} PROJECT_ID \"NAME\" [flags]`, [
    "--root DIR (default: current directory)", "--pipeline-root DIR (default: ROOT/pipelines)",
    "--pipeline SELECTOR (default: default)",
  ], [`axi-factorio project ${action} <project-id> \"<name>\" --root <dir>`, `axi-factorio project show <project-id>`]);
}

function simpleBlobHelp(command: string, purpose: string): string {
  return commandHelp(`axi-factorio ${command} BLOB_ID`, [`Purpose: ${purpose}`], [
    `axi-factorio ${command} <id>`, "axi-factorio show <id>",
  ]);
}

function rootEvidenceHelp(command: "relocate" | "bind-execution"): string {
  return commandHelp(`axi-factorio ${command} BLOB_ID --root DIR [--evidence REF...]`, [
    "--root DIR (required)", "--evidence REF (repeatable)",
  ], [`axi-factorio ${command} <id> --root <dir> --evidence <ref>`, "axi-factorio show <id>"]);
}

function twoIdHelp(command: "rewind" | "kick"): string {
  return commandHelp(`axi-factorio ${command} BLOB_ID STEP_ID`, [], [
    `axi-factorio ${command} <id> <step-id>`, "axi-factorio show <id>",
  ]);
}

function runnerHelp(command: "run" | "evaluate"): string {
  return commandHelp(`axi-factorio ${command} [flags]`, [
    "--harness SELECTOR (default: codex)", "--instrumentation SELECTOR (default: none)",
  ], [`axi-factorio ${command}`, `axi-factorio ${command} --harness module:<specifier>#<export>`]);
}

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
import { ArtifactPresenceHarness } from "./ArtifactPresenceHarness.ts";
import { verifyArtifacts } from "./ArtifactRules.ts";
import { LocalEndpointSupervisor } from "./LocalEndpointSupervisor.ts";
import { ConveyorService } from "./Service.ts";
import { runCoupledService } from "./ServiceRuntime.ts";
import { axiDescription, axiHomeHelp } from "./AxiGuidance.ts";
import { installAxiFactorioHooks } from "./AxiSetup.ts";
import {
  type ServiceStatus,
  installService,
  showServiceStatus,
  startServiceViewer,
  uninstallService,
} from "./ServiceInstall.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
