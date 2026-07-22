export class MockHarnessLab {
  private root = "";
  private databasePath = "";
  private database!: FactorioDatabase;
  private store!: ConveyorStore;
  private harness!: MockAgentHarness;
  private runner!: ConveyorRunner;
  private steps: StepDefinition[] = [];
  private activeWork: Promise<void> | null = null;
  private selectedScenario = "first-attempt";
  private editor: LabEditorState = emptyEditor();
  private notice = "Ready for one controlled step.";

  constructor() {
    this.reset();
  }

  reset(): LabSnapshot {
    this.disposeCurrent();
    this.createTemporaryWorkspace();
    this.createLearningBlob();
    this.selectedScenario = "first-attempt";
    this.editor = emptyEditor();
    this.notice = "Fresh temporary SQLite laboratory. Step is the primary action.";
    return this.snapshot();
  }

  async action(action: LabAction): Promise<LabSnapshot> {
    if (action === "reset") return this.reset();
    if (action === "play") return this.runContinuous();
    if (action === "step") return this.runStep();
    if (action === "stop") return this.stop();
    if (action === "retry") return this.retry();
    if (action === "feedback") return this.feedback();
    if (action === "approve") return this.approve();
    if (action === "fail") return this.fail();
    if (action === "block") return this.block();
    if (action === "retry-decision") return this.retryDecision();
    if (action === "bounded-retry") return this.boundedRetry();
    if (action === "bounded-failed-retry") return this.boundedFailedRetry();
    if (action === "bounded-human-feedback") return this.boundedHumanFeedback();
    if (action === "rewind-step") return this.rewindAndStep();
    if (action === "restart") return this.restart();
    return this.snapshot();
  }

  async selectScenario(id: string): Promise<LabSnapshot> {
    if (!scenarioCatalog.some((scenario) => scenario.id === id)) {
      throw new Error(`Unknown Workbench scenario: ${id}`);
    }
    this.reset();
    this.selectedScenario = id;
    await scenarioPreparers[id](this);
    return this.snapshot();
  }

  previewBlobEdit(body: string): LabSnapshot {
    const blob = this.store.getBlob(blobId)!;
    this.editor = validateBlobEdit(blob.body, body);
    this.notice = this.editor.error ?? "Blob diff is ready. Save creates a durable revision.";
    return this.snapshot();
  }

  saveBlobEdit(): LabSnapshot {
    if (this.editor.kind !== "blob" || !this.editor.valid) {
      throw new Error("Preview a valid blob edit before saving.");
    }
    this.writeBlobRevision(this.editor.after);
    this.editor = { ...this.editor, saved: true };
    this.notice = "Saved a durable blob revision. Historical attempt inputs were not changed.";
    return this.snapshot();
  }

  previewPromptEdit(kind: PromptKind, content: string): LabSnapshot {
    const path = this.promptPath(kind);
    const before = readFileSync(path, "utf8");
    this.editor = validatePromptEdit(kind, path, before, content);
    this.notice = this.editor.error ?? `Diff ready for the real ${basename(path)} file.`;
    return this.snapshot();
  }

  savePromptEdit(): LabSnapshot {
    if (this.editor.kind !== "prompt" || !this.editor.valid || !this.editor.path) {
      throw new Error("Preview a valid prompt edit before saving.");
    }
    writeFileSync(this.editor.path, this.editor.after);
    this.steps = discoverPipeline(this.store.getBlob(blobId)!.pipelinePath);
    this.editor = { ...this.editor, saved: true };
    this.notice = `Saved the actual local pipeline file ${basename(this.editor.path)}.`;
    return this.snapshot();
  }

  cancelEdit(): LabSnapshot {
    this.editor = emptyEditor("Edit cancelled. No blob revision or Markdown file was written.");
    this.notice = this.editor.message;
    return this.snapshot();
  }

  promptContent(kind: PromptKind): string {
    return readFileSync(this.promptPath(kind), "utf8");
  }

  queueHumanFeedback(text: string): LabSnapshot {
    this.store.addHumanFeedback(blobId, text, ["human:scenario"]);
    this.notice = "Blocked attempt with durable human feedback queued for the same step.";
    return this.snapshot();
  }

  prepareCancelInvalidEdit(): LabSnapshot {
    const before = this.promptContent("entry");
    this.previewPromptEdit("entry", `${before.trim()}\n\nThis edit will be cancelled.`);
    this.cancelEdit();
    this.previewPromptEdit("entry", "");
    this.notice = "A valid edit was cancelled, then an empty edit was rejected. No file was written.";
    return this.snapshot();
  }

  async waitForIdle(): Promise<LabSnapshot> {
    await this.activeWork;
    return this.snapshot();
  }

  snapshot(): LabSnapshot {
    const blob = this.store.getBlob(blobId)!;
    const receipts = this.store.listReceipts(blobId);
    return {
      name: "One-step learning laboratory",
      description: this.notice,
      scenarioCatalog,
      selectedScenario: this.selectedScenario,
      steps: this.steps.map(viewStep),
      currentDefinition: snapshotDefinition(this.steps[0], blob.pipelinePath),
      blob: viewBlob(blob, this.currentRevision()),
      receipts,
      attempts: this.attempts(receipts),
      events: this.store.listExecutionEvents(blobId),
      humanInputs: this.store.listHumanInputs(blobId),
      editor: this.editor,
      assertions: labAssertions(blob, receipts, this.attempts(receipts)),
    };
  }

  dispose(): void {
    this.disposeCurrent();
    if (this.root) rmSync(this.root, { recursive: true, force: true });
  }

  private createTemporaryWorkspace(): void {
    this.root = mkdtempSync(join(tmpdir(), "axi-factorio-learning-lab-"));
    const pipelinePath = join(this.root, "pipeline");
    cpSync(templatePath, pipelinePath, { recursive: true });
    initializeGit(this.root);
    this.databasePath = join(this.root, "factorio.sqlite");
    this.open(pipelinePath);
  }

  private createLearningBlob(): void {
    const pipelinePath = join(this.root, "pipeline");
    this.store.createBlob(blobId, {
      title: "Improve the learning result",
      body: "Implement the request and preserve evidence.",
      cwd: this.root,
      pipelinePath,
      inputArtifacts: ["request:learning-loop"],
    });
    this.insertRevision(1, "Improve the learning result", "Implement the request and preserve evidence.");
  }

  private open(pipelinePath: string): void {
    this.database = new FactorioDatabase(this.databasePath);
    this.createWorkbenchTables();
    this.store = new ConveyorStore(this.database);
    this.harness = new MockAgentHarness(350);
    this.runner = new ConveyorRunner(this.store, this.harness);
    this.steps = discoverPipeline(pipelinePath);
  }

  private createWorkbenchTables(): void {
    this.database.connection.exec(workbenchSchema);
  }

  private async runContinuous(): Promise<LabSnapshot> {
    this.store.requestContinuous(blobId);
    this.startWork();
    this.notice = "Continuous Play started. Step remains the learning-loop default.";
    return this.snapshot();
  }

  private async runStep(): Promise<LabSnapshot> {
    this.store.requestStep(blobId);
    await this.startWork();
    this.notice = "Exactly one pipeline step ran. Inspect the complete attempt below.";
    return this.snapshot();
  }

  private async stop(): Promise<LabSnapshot> {
    this.store.requestStop(blobId);
    await this.activeWork;
    this.notice = "Stopped safely after the active transition; no following step was claimed.";
    return this.snapshot();
  }

  private async retry(): Promise<LabSnapshot> {
    this.store.retryBlob(blobId);
    await this.startWork();
    this.notice = "Retried the paused current step without deleting history.";
    return this.snapshot();
  }

  private async feedback(): Promise<LabSnapshot> {
    this.store.addHumanFeedback(blobId, "Tighten the implementation and preserve the evidence.", ["human:mock"]);
    await this.startWork();
    this.notice = "Human feedback resumed the same step and external run.";
    return this.snapshot();
  }

  private async approve(): Promise<LabSnapshot> {
    this.store.approveHumanGate(blobId, "Approved at exact mock head.", ["head:mock-approved"]);
    await this.startWork();
    this.notice = "Approval evidence resumed exactly one queued step.";
    return this.snapshot();
  }

  private async fail(): Promise<LabSnapshot> {
    this.harness.failNext();
    if (this.store.getBlob(blobId)?.paused) this.store.retryBlob(blobId);
    else this.store.requestStep(blobId);
    await this.startWork();
    this.notice = "The deterministic harness failed; prior evidence remains inspectable.";
    return this.snapshot();
  }

  private async block(): Promise<LabSnapshot> {
    this.harness.blockNext();
    this.store.requestStep(blobId);
    await this.startWork();
    this.notice = "The attempt blocked and is waiting for explicit human input.";
    return this.snapshot();
  }

  private async retryDecision(): Promise<LabSnapshot> {
    this.harness.retryNext();
    this.store.requestStep(blobId);
    await this.startWork();
    this.notice = "The harness returned retry. Progress stayed on the same step.";
    return this.snapshot();
  }

  private async boundedRetry(): Promise<LabSnapshot> {
    this.store.requestContinuous(blobId);
    this.harness.retryNext();
    this.store.requestStep(blobId);
    await this.startWork();
    this.notice = "One bounded Step returned retry and stopped; the preferred mode remains continuous.";
    return this.snapshot();
  }

  private async boundedFailedRetry(): Promise<LabSnapshot> {
    this.store.requestContinuous(blobId);
    this.harness.failNext();
    await this.startWork();
    this.store.retryBlob(blobId, true);
    this.restart();
    this.harness.retryNext();
    await this.startWork();
    this.notice = "A paused failure received one bounded retry; retry stopped without changing continuous preference.";
    return this.snapshot();
  }

  private async boundedHumanFeedback(): Promise<LabSnapshot> {
    this.store.requestContinuous(blobId);
    this.harness.blockNext();
    this.store.requestStep(blobId);
    await this.startWork();
    this.store.addHumanFeedback(blobId, "Proceed for one bounded attempt.", ["human:authorized"], false);
    this.store.requestStep(blobId);
    await this.startWork();
    this.notice = "Feedback was recorded without scheduling; one later Step produced exactly one receipt.";
    return this.snapshot();
  }

  private async rewindAndStep(): Promise<LabSnapshot> {
    const target = this.steps[0];
    this.store.rewindBlob(blobId, target, this.steps);
    this.store.requestStep(blobId);
    await this.startWork();
    this.notice = "Rewound and reran the same step. Superseded history is retained for comparison.";
    return this.snapshot();
  }

  private restart(): LabSnapshot {
    const pipelinePath = this.store.getBlob(blobId)!.pipelinePath;
    this.database.close();
    this.open(pipelinePath);
    this.notice = "Reopened the temporary SQLite database and production Store/Runner boundary.";
    return this.snapshot();
  }

  private startWork(): Promise<void> {
    if (this.activeWork) return this.activeWork;
    const tracked = this.drain().finally(() => {
      if (this.activeWork === tracked) this.activeWork = null;
    });
    this.activeWork = tracked;
    return tracked;
  }

  private async drain(): Promise<void> {
    while (this.store.getBlob(blobId)?.runRequested) {
      const before = new Set(this.store.listReceipts(blobId).map((receipt) => receipt.id));
      const ran = await this.runSafely();
      this.captureNewAttempts(before);
      if (!ran) break;
    }
  }

  private async runSafely(): Promise<boolean> {
    try {
      return await new ConveyorService(this.store, this.runner).runOnce(new AbortController().signal);
    } catch (error) {
      if (!(error instanceof ReceiptRunError)) throw error;
      return false;
    }
  }

  private captureNewAttempts(before: Set<string>): void {
    for (const receipt of this.store.listReceipts(blobId)) {
      if (before.has(receipt.id) || this.attemptEvidence(receipt.id)) continue;
      this.captureAttempt(receipt);
    }
  }

  private captureAttempt(receipt: Receipt): void {
    const blob = this.store.getBlob(blobId)!;
    const revision = this.currentRevision();
    const step = this.steps.find((candidate) => candidate.id === receipt.stepId)!;
    const definition = snapshotDefinition(step, blob.pipelinePath);
    const evidence = createAttemptEvidence(receipt, blob, revision, definition, this.store.listExecutionEvents(blobId));
    this.database.connection.prepare(attemptEvidenceInsert).run(
      receipt.id, JSON.stringify(evidence), new Date().toISOString(),
    );
  }

  private attempts(receipts: Receipt[]): LabAttempt[] {
    return receipts.map((receipt) => {
      const evidence = this.attemptEvidence(receipt.id) ?? fallbackEvidence(receipt);
      return { ...evidence, receipt };
    });
  }

  private attemptEvidence(receiptId: string): AttemptEvidence | null {
    const row = this.database.connection.prepare(attemptEvidenceSelect).get(receiptId) as
      | { evidenceJson: string }
      | undefined;
    return row ? JSON.parse(row.evidenceJson) as AttemptEvidence : null;
  }

  private writeBlobRevision(body: string): void {
    const previous = this.currentRevision();
    const blob = this.store.getBlob(blobId)!;
    const revision = previous.revision + 1;
    const at = new Date().toISOString();
    this.database.connection.prepare(blobBodyUpdate).run(body, at, blobId);
    this.insertRevision(revision, blob.title, body);
  }

  private insertRevision(revision: number, title: string, body: string): void {
    this.database.connection.prepare(blobRevisionInsert).run(
      blobId, revision, title, body, contentHash(`${title}\n${body}`), new Date().toISOString(),
    );
  }

  private currentRevision(): BlobRevision {
    const row = this.database.connection.prepare(blobRevisionCurrent).get(blobId);
    if (!row) throw new Error("The learning blob has no durable revision.");
    return mapRevision(row as Record<string, unknown>);
  }

  private promptPath(kind: PromptKind): string {
    const step = this.steps[0];
    return kind === "entry" ? step.entryPath : step.exitPath;
  }

  private disposeCurrent(): void {
    try { this.database?.close(); } catch {}
  }
}

function createAttemptEvidence(
  receipt: Receipt,
  blob: Blob,
  revision: BlobRevision,
  definition: DefinitionSnapshot,
  events: ExecutionEvent[],
): AttemptEvidence {
  const elapsedMs = receipt.finishedAt
    ? Math.max(0, Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt))
    : null;
  return {
    blobRevision: revision,
    inputSnapshot: {
      title: blob.title,
      body: revision.body,
      inputArtifacts: blob.inputArtifacts,
    },
    definition,
    harness: receipt.adapter,
    model: "deterministic-v1",
    externalRunId: receipt.externalRunId,
    decision: receipt.status,
    reason: receipt.reason ?? receipt.error,
    outputArtifacts: receipt.outputArtifacts,
    eventIds: events.filter((event) => event.receiptId === receipt.id).map((event) => event.id),
    elapsedMs,
    inputTokens: estimateTokens(`${revision.title}\n${revision.body}\n${definition.entry}\n${definition.exit}`),
    outputTokens: estimateTokens(`${receipt.reason ?? receipt.error ?? ""}\n${receipt.outputArtifacts.join("\n")}`),
  };
}

function fallbackEvidence(receipt: Receipt): AttemptEvidence {
  return {
    blobRevision: { revision: 0, title: "", body: "", contentHash: "", createdAt: receipt.startedAt },
    inputSnapshot: { title: "", body: "", inputArtifacts: receipt.inputArtifacts },
    definition: {
      gitSha: receipt.definitionGitSha,
      contentHash: receipt.definitionHash,
      entry: "",
      exit: "",
    },
    harness: receipt.adapter,
    model: "unavailable",
    externalRunId: receipt.externalRunId,
    decision: receipt.status,
    reason: receipt.reason ?? receipt.error,
    outputArtifacts: receipt.outputArtifacts,
    eventIds: [],
    elapsedMs: null,
    inputTokens: null,
    outputTokens: null,
  };
}

function validateBlobEdit(before: string, after: string): LabEditorState {
  const trimmed = after.trim();
  if (!trimmed) return invalidEditor("blob", before, after, "Blob content cannot be empty.");
  if (after === before) return invalidEditor("blob", before, after, "Blob content is unchanged.");
  return validEditor("blob", before, after);
}

function validatePromptEdit(
  kind: PromptKind,
  path: string,
  before: string,
  after: string,
): LabEditorState {
  if (!after.trim()) return invalidEditor("prompt", before, after, `${titleCase(kind)} Markdown cannot be empty.`, kind, path);
  if (after.includes("\0")) return invalidEditor("prompt", before, after, "Markdown cannot contain a NUL byte.", kind, path);
  if (after === before) return invalidEditor("prompt", before, after, "Prompt content is unchanged.", kind, path);
  return validEditor("prompt", before, after, kind, path);
}

function validEditor(
  kind: EditorKind,
  before: string,
  after: string,
  promptKind?: PromptKind,
  path?: string,
): LabEditorState {
  return { kind, promptKind, path, before, after, diff: lineDiff(before, after), valid: true, error: null, saved: false, message: "" };
}

function invalidEditor(
  kind: EditorKind,
  before: string,
  after: string,
  error: string,
  promptKind?: PromptKind,
  path?: string,
): LabEditorState {
  return { kind, promptKind, path, before, after, diff: lineDiff(before, after), valid: false, error, saved: false, message: error };
}

function emptyEditor(message = ""): LabEditorState {
  return {
    kind: "none",
    before: "",
    after: "",
    diff: [],
    valid: false,
    error: null,
    saved: false,
    message,
  };
}

function lineDiff(before: string, after: string): DiffLine[] {
  if (before === after) return before.split("\n").map((text) => ({ kind: "same", text }));
  return [
    ...before.split("\n").map((text) => ({ kind: "remove" as const, text })),
    ...after.split("\n").map((text) => ({ kind: "add" as const, text })),
  ];
}

function labAssertions(blob: Blob, receipts: Receipt[], attempts: LabAttempt[]): LabAssertion[] {
  const latestReceipt = receipts.at(-1);
  return [
    {
      label: "Every receipt has immutable Workbench input and prompt evidence",
      passed: receipts.length === attempts.length && attempts.every((attempt) =>
        attempt.blobRevision.revision > 0 && Boolean(attempt.definition.contentHash)),
    },
    {
      label: "Superseded receipts stay available for comparison",
      passed: receipts.every((receipt) => attempts.some((attempt) => attempt.receipt.id === receipt.id)),
    },
    {
      label: "Step mode never queues a following transition",
      passed: blob.executionMode !== "step"
        || !blob.runRequested
        || latestReceipt?.stepId === blob.state,
    },
  ];
}

function viewStep(step: StepDefinition): LabStep {
  return {
    id: step.id,
    label: titleCase(step.id.split(".").at(-1)!),
    entryPath: step.entryPath,
    exitPath: step.exitPath,
  };
}

function viewBlob(blob: Blob, revision: BlobRevision): LabBlob {
  return {
    id: blob.id,
    title: blob.title,
    body: blob.body,
    state: blob.state,
    paused: blob.paused,
    runRequested: blob.runRequested,
    executionMode: blob.executionMode,
    revision,
  };
}

function mapRevision(row: Record<string, unknown>): BlobRevision {
  return {
    revision: Number(row.revision),
    title: String(row.title),
    body: String(row.body),
    contentHash: String(row.contentHash),
    createdAt: String(row.createdAt),
  };
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function initializeGit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "factorio@test.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Factorio Learning Lab"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "learning lab fixture"], { cwd: root });
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const scenarioCatalog: LabScenario[] = [
  { id: "first-attempt", category: "Inspect", name: "First attempt inspection", description: "Step once, then inspect complete evidence." },
  { id: "blob-edit", category: "Edit", name: "Durable blob revision", description: "Edit blob content without rewriting attempt #1." },
  { id: "prompt-edit", category: "Edit", name: "Real Markdown diff", description: "Preview and save the actual entry Markdown." },
  { id: "rerun", category: "Rerun", name: "Rerun same step", description: "Rewind and execute the same step again." },
  { id: "compare", category: "Compare", name: "Compare attempts", description: "Compare immutable attempt provenance side by side." },
  { id: "retry", category: "Decisions", name: "Retry decision", description: "The harness asks to retry without advancing." },
  { id: "bounded-retry", category: "Controls", name: "One bounded attempt", description: "Step once from continuous preference · retry stops · no surprise next attempt." },
  { id: "bounded-failed-retry", category: "Controls", name: "Bounded failed retry", description: "Paused failure · Retry once · restart-safe budget · no cascade." },
  { id: "bounded-human-feedback", category: "Controls", name: "Record feedback, then Step", description: "Paused human gate · durable feedback only · one bounded receipt · continuous preference preserved." },
  { id: "blocked", category: "Decisions", name: "Blocked with human input", description: "Block, append feedback, and retain the run identity." },
  { id: "failure", category: "Decisions", name: "Harness failure", description: "Fail safely with evidence retained." },
  { id: "improved", category: "Learning", name: "Improved second attempt", description: "Edit, rerun, and advance on attempt #2." },
  { id: "cancel-invalid", category: "Validation", name: "Cancel and invalid edit", description: "Reject an empty prompt and cancel without writing." },
];

const scenarioPreparers: Record<string, (lab: MockHarnessLab) => Promise<void>> = {
  "first-attempt": async (lab) => { await lab.action("step"); },
  "blob-edit": async (lab) => {
    await lab.action("step");
    lab.previewBlobEdit("Implement the improved request and preserve exact evidence.");
    lab.saveBlobEdit();
  },
  "prompt-edit": async (lab) => {
    await lab.action("step");
    const before = lab.promptContent("entry");
    lab.previewPromptEdit("entry", `${before.trim()}\n\nReturn concise evidence.`);
    lab.savePromptEdit();
  },
  "rerun": async (lab) => {
    await lab.action("step");
    await lab.action("rewind-step");
  },
  "compare": async (lab) => {
    await lab.action("step");
    lab.previewBlobEdit("Implement the improved request and preserve exact evidence.");
    lab.saveBlobEdit();
    const before = lab.promptContent("exit");
    lab.previewPromptEdit("exit", `${before.trim()}\n\nPrefer the improved evidence.`);
    lab.savePromptEdit();
    await lab.action("rewind-step");
  },
  "retry": async (lab) => { await lab.action("retry-decision"); },
  "bounded-retry": async (lab) => { await lab.action("bounded-retry"); },
  "bounded-failed-retry": async (lab) => { await lab.action("bounded-failed-retry"); },
  "bounded-human-feedback": async (lab) => { await lab.action("bounded-human-feedback"); },
  "blocked": async (lab) => {
    await lab.action("block");
    lab.queueHumanFeedback("Tighten the implementation.");
  },
  "failure": async (lab) => { await lab.action("fail"); },
  "improved": async (lab) => {
    await lab.action("retry-decision");
    lab.previewBlobEdit("Implement the improved request with concise evidence.");
    lab.saveBlobEdit();
    const before = lab.promptContent("entry");
    lab.previewPromptEdit("entry", `${before.trim()}\n\nUse the revised blob input.`);
    lab.savePromptEdit();
    await lab.action("rewind-step");
  },
  "cancel-invalid": async (lab) => { lab.prepareCancelInvalidEdit(); },
};

const workbenchSchema = `
  CREATE TABLE IF NOT EXISTS workbenchBlobRevisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blobId TEXT NOT NULL,
    revision INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    contentHash TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    UNIQUE(blobId, revision)
  );
  CREATE TABLE IF NOT EXISTS workbenchAttemptEvidence (
    receiptId TEXT PRIMARY KEY,
    evidenceJson TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
`;
const blobRevisionInsert = `INSERT INTO workbenchBlobRevisions
  (blobId, revision, title, body, contentHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)`;
const blobRevisionCurrent = `SELECT * FROM workbenchBlobRevisions
  WHERE blobId = ? ORDER BY revision DESC LIMIT 1`;
const attemptEvidenceInsert = `INSERT INTO workbenchAttemptEvidence
  (receiptId, evidenceJson, createdAt) VALUES (?, ?, ?)`;
const attemptEvidenceSelect = "SELECT evidenceJson FROM workbenchAttemptEvidence WHERE receiptId = ?";
const blobBodyUpdate = "UPDATE blobs SET body = ?, updatedAt = ? WHERE id = ?";
const blobId = "learning-lab-blob";
const templatePath = join(dirname(fileURLToPath(import.meta.url)), "mock");

export type PromptKind = "entry" | "exit";
export type EditorKind = "none" | "blob" | "prompt";
export type LabAction =
  | "reset"
  | "play"
  | "step"
  | "stop"
  | "retry"
  | "feedback"
  | "approve"
  | "fail"
  | "block"
  | "retry-decision"
  | "bounded-retry"
  | "bounded-failed-retry"
  | "bounded-human-feedback"
  | "rewind-step"
  | "restart";
export type LabScenario = { id: string; category: string; name: string; description: string };
export type BlobRevision = {
  revision: number;
  title: string;
  body: string;
  contentHash: string;
  createdAt: string;
};
export type AttemptEvidence = {
  blobRevision: BlobRevision;
  inputSnapshot: { title: string; body: string; inputArtifacts: string[] };
  definition: DefinitionSnapshot;
  harness: string;
  model: string;
  externalRunId: string | null;
  decision: string;
  reason: string | null;
  outputArtifacts: string[];
  eventIds: number[];
  elapsedMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type LabAttempt = AttemptEvidence & { receipt: Receipt };
export type DiffLine = { kind: "same" | "remove" | "add"; text: string };
export type LabEditorState = {
  kind: EditorKind;
  promptKind?: PromptKind;
  path?: string;
  before: string;
  after: string;
  diff: DiffLine[];
  valid: boolean;
  error: string | null;
  saved: boolean;
  message: string;
};
export type LabAssertion = { label: string; passed: boolean };
export type LabStep = { id: string; label: string; entryPath: string; exitPath: string };
export type LabBlob = Pick<Blob, "id" | "title" | "body" | "state" | "paused" | "runRequested" | "executionMode"> & {
  revision: BlobRevision;
};
export type LabSnapshot = {
  name: string;
  description: string;
  scenarioCatalog: LabScenario[];
  selectedScenario: string;
  steps: LabStep[];
  currentDefinition: DefinitionSnapshot;
  blob: LabBlob;
  receipts: Receipt[];
  attempts: LabAttempt[];
  events: ExecutionEvent[];
  humanInputs: HumanInput[];
  editor: LabEditorState;
  assertions: LabAssertion[];
};

import type {
  Blob,
  DefinitionSnapshot,
  ExecutionEvent,
  HumanInput,
  Receipt,
  StepDefinition,
} from "../../src/Types.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { ConveyorRunner, ReceiptRunError } from "../../src/Runner.ts";
import { ConveyorService } from "../../src/Service.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { discoverPipeline, snapshotDefinition } from "../../src/Pipeline.ts";
import { MockAgentHarness } from "./MockHarness.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
