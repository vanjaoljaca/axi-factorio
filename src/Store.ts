export class ConveyorStore {
  private readonly database: FactorioDatabase;
  private readonly now: () => string;

  constructor(
    database: FactorioDatabase,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.database = database;
    this.now = now;
  }

  createProject(id: string, input: ProjectInput): ProjectMutationResult {
    return this.database.transaction(() => this.ensureProject(id, input));
  }

  upsertProject(id: string, input: ProjectInput): ProjectMutationResult {
    return this.database.transaction(() => this.ensureProject(id, input, true));
  }

  getProject(id: string): Project | null {
    const row = this.database.connection.prepare(projectSelect).get(id);
    return row ? mapProject(asRecord(row)) : null;
  }

  listProjects(): Project[] {
    return this.database.connection.prepare(projectList).all().map((row) => mapProject(asRecord(row)));
  }

  createBlob(id: string, input: BlobInput): BlobMutationResult {
    return this.database.transaction(() => {
      const existing = this.getBlob(id);
      if (existing) return this.existingBlob(existing, input);
      const at = this.now();
      const initialState = discoverPipeline(input.pipelinePath)[0].id;
      const pipelineId = input.pipelineId ?? input.pipelinePath;
      const projectId = input.projectId ?? "default";
      if (!this.getProject(projectId)) this.ensureProject(projectId, {
        name: projectId === "default" ? "Default" : projectId,
        root: input.cwd,
        pipelineRoot: dirname(input.pipelinePath),
        defaultPipeline: "default",
      });
      this.database.connection.prepare(blobInsert).run(
        id, projectId, input.title, input.body, input.cwd, pipelineId, input.pipelinePath,
        JSON.stringify(input.inputArtifacts), initialState, at, at,
      );
      this.insertBlobRevision(id, 1, input.title, input.body, at);
      return { blob: this.requireBlob(id), already: false };
    });
  }

  nextQueuedBlob(): Blob | null {
    const row = this.database.connection.prepare(blobNext).get();
    return row ? mapBlob(asRecord(row)) : null;
  }

  requestContinuous(blobId: string): BlobMutationResult {
    return this.requestExecution(blobId, "continuous");
  }

  requestStep(blobId: string): BlobMutationResult {
    return this.requestExecution(blobId, "step");
  }

  requestStop(blobId: string): BlobMutationResult {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (!blob.runRequested) return { blob, already: true };
      this.database.connection.prepare(blobStopUpdate).run(this.now(), blob.id);
      return { blob: this.requireBlob(blob.id), already: false };
    });
  }

  beginReceipt(input: BeginReceiptInput, ownerId?: string): ClaimedExecution {
    return this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const blob = this.requireBlob(input.blobId);
      if (blob.state !== input.step.id || blob.paused || !blob.runRequested) {
        throw new Error(`Blob ${blob.id} is not ready for ${input.step.id}.`);
      }
      const receipt = this.insertReceipt(blob, input);
      return { blob: this.requireBlob(blob.id), receipt, step: input.step, definition: input.definition };
    });
  }

  recordExternalRun(receiptId: string, externalRunId: string, ownerId?: string): void {
    this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const receipt = this.requireReceipt(receiptId);
      if (receipt.externalRunId && receipt.externalRunId !== externalRunId) {
        throw new Error("Harness external run ID changed.");
      }
      this.database.connection.prepare(receiptExternalRunUpdate).run(externalRunId, receiptId);
    });
  }

  completeReceipt(
    receiptId: string,
    result: ExecutionResult,
    nextStepId: string | null,
    ownerId?: string,
  ): Blob {
    return this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const receipt = this.requireReceipt(receiptId);
      const effectiveResult = this.enforceHumanGate(receipt, result);
      this.finishReceipt(receipt.id, effectiveResult);
      this.projectResult(receipt, effectiveResult, nextStepId);
      return this.requireBlob(receipt.blobId);
    });
  }

  failReceipt(receiptId: string, error: unknown, ownerId?: string): void {
    this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const receipt = this.requireReceipt(receiptId);
      const message = error instanceof Error ? error.message : String(error);
      this.database.connection.prepare(receiptFailureUpdate).run(message, this.now(), receipt.id);
      this.database.connection.prepare(blobPauseAndRunUpdate).run(1, 0, this.now(), receipt.blobId);
    });
  }

  interruptReceipt(receiptId: string, ownerId?: string, reason = "Dispatcher stopped before completion."): void {
    this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const receipt = this.requireReceipt(receiptId);
      this.database.connection.prepare(receiptInterruptUpdate).run(reason, this.now(), receipt.id);
      this.database.connection.prepare(blobPauseAndRunUpdate).run(1, 0, this.now(), receipt.blobId);
    });
  }

  markCompleted(blobId: string, ownerId?: string): Blob {
    return this.database.transaction(() => {
      this.requireActiveLease(ownerId);
      const blob = this.requireBlob(blobId);
      if (blob.state === "complete") return blob;
      this.database.connection.prepare(blobCompleteUpdate).run(this.now(), blob.id);
      return this.requireBlob(blob.id);
    });
  }

  retryBlob(blobId: string): BlobMutationResult {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (!blob.paused) return { blob, already: true };
      this.database.connection.prepare(blobPauseAndRunUpdate).run(0, 1, this.now(), blob.id);
      return { blob: this.requireBlob(blob.id), already: false };
    });
  }

  adoptBlob(
    blobId: string,
    target: StepDefinition,
    steps: StepDefinition[],
    sourceIdentity: string,
    attestations: ImportAttestation[],
  ): Blob {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      this.validateAdoption(blob, target, steps, sourceIdentity, attestations);
      for (const attestation of attestations) this.insertImportedReceipt(blob, sourceIdentity, attestation);
      const previous = attestations.at(-1)!;
      this.database.connection.prepare(blobAdoptUpdate).run(
        target.id, previous.step.id, previous.step.order, this.now(), blob.id,
      );
      return this.requireBlob(blob.id);
    });
  }

  armHumanGate(blobId: string, text = ""): HumanInput {
    return this.appendHumanInput(blobId, "review", text, []);
  }

  addHumanFeedback(blobId: string, text: string, evidence: string[] = []): HumanInput {
    if (!text.trim()) throw new Error("Human feedback cannot be empty.");
    return this.appendHumanInput(blobId, "feedback", text, evidence);
  }

  approveHumanGate(blobId: string, text: string, evidence: string[]): HumanInput {
    if (!evidence.length) throw new Error("Human approval requires at least one evidence reference.");
    return this.appendHumanInput(blobId, "approval", text, evidence);
  }

  rewindBlob(blobId: string, target: StepDefinition, steps: StepDefinition[]): BlobMutationResult {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (this.hasRunningReceipt(blob.id)) throw new Error("A running blob cannot be rewound.");
      const at = this.now();
      const invalidated = this.invalidateReceipts(blob.id, target, steps, at);
      const previous = this.previousValidReceipt(blob.id, target, steps);
      const already = invalidated === 0
        && blob.state === target.id
        && blob.forcedStepId === target.id;
      this.database.connection.prepare(blobRewindUpdate).run(
        target.id, previous?.stepId ?? null, previous?.stepOrder ?? null, target.id, at, blob.id,
      );
      return { blob: this.requireBlob(blob.id), already };
    });
  }

  getBlob(id: string): Blob | null {
    const row = this.database.connection.prepare(blobSelect).get(id);
    return row ? mapBlob(asRecord(row)) : null;
  }

  listBlobs(): Blob[] {
    return this.database.connection.prepare(blobList).all().map((row) => mapBlob(asRecord(row)));
  }

  currentBlobRevision(blobId: string): BlobRevision {
    this.requireBlob(blobId);
    const row = this.database.connection.prepare(blobRevisionCurrent).get(blobId);
    if (!row) throw new Error(`Blob ${blobId} has no revision.`);
    return mapBlobRevision(asRecord(row));
  }

  listBlobRevisions(blobId: string): BlobRevision[] {
    this.requireBlob(blobId);
    return this.database.connection.prepare(blobRevisionList).all(blobId)
      .map((row) => mapBlobRevision(asRecord(row)));
  }

  reviseBlob(blobId: string, title: string, body: string, expectedRevision: number): BlobRevision {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (this.hasRunningReceipt(blob.id)) throw new Error("A running blob cannot be edited.");
      if (!title.trim()) throw new Error("Blob title cannot be empty.");
      if (!body.trim()) throw new Error("Blob content cannot be empty.");
      const current = this.currentBlobRevision(blob.id);
      if (current.revision !== expectedRevision) throw new Error("Blob revision changed; preview the edit again.");
      if (current.title === title && current.body === body) throw new Error("Blob content is unchanged.");
      const at = this.now();
      this.database.connection.prepare(blobContentUpdate).run(title, body, at, blob.id);
      this.insertBlobRevision(blob.id, current.revision + 1, title, body, at);
      return this.currentBlobRevision(blob.id);
    });
  }

  listAttemptEvidence(blobId: string): AttemptEvidence[] {
    this.requireBlob(blobId);
    return this.database.connection.prepare(attemptEvidenceByBlob).all(blobId)
      .map((row) => mapAttemptEvidence(asRecord(row)));
  }

  listReceipts(blobId?: string): Receipt[] {
    const rows = blobId
      ? this.database.connection.prepare(receiptListByBlob).all(blobId)
      : this.database.connection.prepare(receiptList).all();
    return rows.map((row) => mapReceipt(asRecord(row)));
  }

  listExecutionEvents(blobId?: string): ExecutionEvent[] {
    const rows = blobId
      ? this.database.connection.prepare(executionEventsByBlobQuery).all(blobId)
      : this.database.connection.prepare(executionEventsQuery).all();
    return rows.map(executionEventFromRow);
  }

  relocateBlobWorkspace(blobId: string, targetRoot: string, evidence: string[]): WorkspaceRelocation {
    if (!evidence.length) throw new Error("Workspace relocation requires evidence.");
    const resolvedRoot = requireDirectory(targetRoot);
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (this.hasRunningReceipt(blob.id)) throw new Error("A running blob cannot be relocated.");
      const project = this.requireProject(blob.projectId);
      return this.persistWorkspaceRelocation(blob, project, resolvedRoot, evidence);
    });
  }

  listWorkspaceRelocations(blobId?: string): WorkspaceRelocation[] {
    const rows = blobId
      ? this.database.connection.prepare(workspaceRelocationListByBlob).all(blobId)
      : this.database.connection.prepare(workspaceRelocationList).all();
    return rows.map((row) => mapWorkspaceRelocation(asRecord(row)));
  }

  recordExecutionEvent(
    receiptId: string,
    blobId: string,
    stepId: string,
    name: string,
    attributes: Record<string, string | number | boolean>,
  ): void {
    this.database.connection.prepare(executionEventInsert).run(
      receiptId, blobId, stepId, name, JSON.stringify(attributes), this.now(),
    );
  }

  listHumanInputs(blobId?: string): HumanInput[] {
    const rows = blobId
      ? this.database.connection.prepare(humanInputListByBlob).all(blobId)
      : this.database.connection.prepare(humanInputList).all();
    return rows.map((row) => mapHumanInput(asRecord(row)));
  }

  inputArtifactsFor(blobId: string): string[] {
    const blob = this.requireBlob(blobId);
    const refs = [...blob.inputArtifacts];
    for (const receipt of this.validAdvancedReceipts(blobId)) refs.push(...receipt.outputArtifacts);
    return [...new Set(refs)];
  }

  acquireLease(ownerId: string, leaseMs: number): boolean {
    return this.database.transaction(() => {
      const at = this.now();
      const until = new Date(Date.parse(at) + leaseMs).toISOString();
      this.database.connection.prepare(leaseDeleteExpired).run(at);
      const result = this.database.connection.prepare(leaseInsert).run(ownerId, until, at);
      return Number(result.changes) === 1;
    });
  }

  renewLease(ownerId: string, leaseMs: number): boolean {
    const at = this.now();
    const until = new Date(Date.parse(at) + leaseMs).toISOString();
    const result = this.database.connection.prepare(leaseRenew).run(until, at, ownerId, at);
    return Number(result.changes) === 1;
  }

  releaseLease(ownerId: string): void {
    this.database.connection.prepare(leaseRelease).run(ownerId);
  }

  recoverInterruptedReceipts(): number {
    return this.database.transaction(() => {
      const rows = this.database.connection.prepare(runningReceiptList).all();
      for (const row of rows) this.recoverReceipt(mapReceipt(asRecord(row)));
      return rows.length;
    });
  }

  private insertReceipt(blob: Blob, input: BeginReceiptInput): Receipt {
    const id = randomUUID();
    const at = this.now();
    const attempt = this.nextAttempt(blob.id, input.step.id);
    const continuation = this.continuationThreadFor(blob.id, input.step.id);
    const humanInputs = this.pendingHumanInputs(blob.id, input.step.id)
      .map((item) => ({ ...item, receiptId: id }));
    const currentApproval = this.currentApproval(blob);
    const approval = currentApproval ? { ...currentApproval, receiptId: id } : null;
    this.database.connection.prepare(receiptInsert).run(
      id, blob.id, input.step.id, input.step.order, attempt, input.adapter,
      input.definition.gitSha, input.definition.contentHash,
      JSON.stringify(input.inputArtifacts), continuation,
      JSON.stringify(humanInputs), approval ? JSON.stringify(approval) : null, at,
    );
    this.database.connection.prepare(humanInputReceiptUpdate).run(id, blob.id, input.step.id);
    this.insertAttemptEvidence(id, blob, input, at);
    return this.requireReceipt(id);
  }

  private insertAttemptEvidence(id: string, blob: Blob, input: BeginReceiptInput, at: string): void {
    const revision = this.currentBlobRevision(blob.id);
    this.database.connection.prepare(attemptEvidenceInsert).run(
      id, revision.revision, revision.title, revision.body, revision.contentHash,
      input.definition.gitSha, input.definition.contentHash,
      input.definition.entry, input.definition.exit,
      input.adapter, input.model ?? null, JSON.stringify(input.inputArtifacts), at,
    );
  }

  private insertBlobRevision(
    blobId: string,
    revision: number,
    title: string,
    body: string,
    at: string,
  ): void {
    this.database.connection.prepare(blobRevisionInsert).run(
      blobId, revision, title, body, revisionHash(title, body), at,
    );
  }

  private insertImportedReceipt(
    blob: Blob,
    sourceIdentity: string,
    attestation: ImportAttestation,
  ): void {
    const at = this.now();
    this.database.connection.prepare(importedReceiptInsert).run(
      randomUUID(), blob.id, attestation.step.id, attestation.step.order,
      sourceIdentity, JSON.stringify(attestation.evidence),
      attestation.definition.gitSha, attestation.definition.contentHash,
      JSON.stringify(blob.inputArtifacts), JSON.stringify(attestation.evidence), at, at,
    );
  }

  private validateAdoption(
    blob: Blob,
    target: StepDefinition,
    steps: StepDefinition[],
    sourceIdentity: string,
    attestations: ImportAttestation[],
  ): void {
    if (this.hasRunningReceipt(blob.id)) throw new Error("A running blob cannot be adopted.");
    if (!/^[^:\s]+:.+$/u.test(sourceIdentity)) throw new Error("Adoption requires an exact kind:value source identity.");
    if (this.listReceipts(blob.id).length) throw new Error("Adoption requires a blob with no existing receipts.");
    const prior = steps.slice(0, steps.findIndex((step) => step.id === target.id));
    if (!prior.length) throw new Error("Adoption must attest at least one prior step.");
    if (attestations.length !== prior.length) throw new Error("Adoption evidence must cover every prior step.");
    for (const [index, step] of prior.entries()) {
      const attestation = attestations[index];
      if (attestation.step.id !== step.id) throw new Error(`Adoption evidence is out of order at ${step.id}.`);
      if (!attestation.evidence.length) throw new Error(`Adoption evidence is required for ${step.id}.`);
    }
  }

  private finishReceipt(receiptId: string, result: ExecutionResult): void {
    this.database.connection.prepare(receiptCompleteUpdate).run(
      result.status, JSON.stringify(result.outputArtifacts), result.externalRunId,
      result.reason, this.now(), receiptId,
    );
  }

  private enforceHumanGate(receipt: Receipt, result: ExecutionResult): ExecutionResult {
    if (result.status !== "advance") return result;
    const blob = this.requireBlob(receipt.blobId);
    if (blob.humanGateStepId !== receipt.stepId || blob.humanGateApprovalInputId) return result;
    return {
      ...result,
      status: "blocked",
      reason: "Awaiting explicit human approval evidence.",
    };
  }

  private projectResult(receipt: Receipt, result: ExecutionResult, nextStepId: string | null): void {
    const blob = this.requireBlob(receipt.blobId);
    const continueRun = Number(blob.runRequested && blob.executionMode === "continuous");
    if (result.status === "retry") {
      this.database.connection.prepare(blobPauseAndRunUpdate).run(0, continueRun, this.now(), receipt.blobId);
      return;
    }
    if (result.status === "blocked") {
      this.database.connection.prepare(blobPauseAndRunUpdate).run(1, 0, this.now(), receipt.blobId);
      return;
    }
    const state = nextStepId ?? "complete";
    this.database.connection.prepare(blobAdvanceUpdate).run(
      state, 0, nextStepId ? continueRun : 0,
      receipt.stepId, receipt.stepOrder, this.now(), receipt.blobId,
    );
  }

  private appendHumanInput(
    blobId: string,
    kind: HumanInputKind,
    text: string,
    evidence: string[],
  ): HumanInput {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (blob.state === "complete") throw new Error(`Blob ${blob.id} is complete.`);
      if (this.hasRunningReceipt(blob.id)) throw new Error("Human input cannot be added while a receipt is running.");
      const id = randomUUID();
      this.database.connection.prepare(humanInputInsert).run(
        id, blob.id, blob.state, kind, text, JSON.stringify(evidence), this.now(),
      );
      const approvalId = kind === "approval" ? id : null;
      const runRequested = kind === "review" ? Number(blob.runRequested) : 1;
      this.database.connection.prepare(blobHumanGateUpdate).run(
        blob.state, approvalId, kind === "review" ? Number(blob.paused) : 0,
        runRequested, this.now(), blob.id,
      );
      return this.requireHumanInput(id);
    });
  }

  private continuationThreadFor(blobId: string, stepId: string): string | null {
    const row = this.database.connection.prepare(receiptContinuationSelect).get(blobId, stepId);
    return row ? nullableString(asRecord(row).externalRunId) : null;
  }

  private pendingHumanInputs(blobId: string, stepId: string): HumanInput[] {
    const rows = this.database.connection.prepare(humanInputPendingList).all(blobId, stepId);
    return rows.map((row) => mapHumanInput(asRecord(row)));
  }

  private currentApproval(blob: Blob): HumanInput | null {
    return blob.humanGateApprovalInputId
      ? this.requireHumanInput(blob.humanGateApprovalInputId)
      : null;
  }

  private requireHumanInput(id: string): HumanInput {
    const row = this.database.connection.prepare(humanInputSelect).get(id);
    if (!row) throw new Error(`Human input ${id} was not found.`);
    return mapHumanInput(asRecord(row));
  }

  private recoverReceipt(receipt: Receipt): void {
    const external = receipt.externalRunId ?? "not recorded";
    const reason = `Service restarted before external run ${external} produced a terminal result.`;
    this.database.connection.prepare(receiptInterruptUpdate).run(reason, this.now(), receipt.id);
    this.database.connection.prepare(blobPauseAndRunUpdate).run(1, 0, this.now(), receipt.blobId);
  }

  private requestExecution(blobId: string, mode: ExecutionMode): BlobMutationResult {
    return this.database.transaction(() => {
      const blob = this.requireBlob(blobId);
      if (blob.runRequested && blob.executionMode === mode) return { blob, already: true };
      const blocker = this.executionBlocker(blob);
      if (blocker) throw new BlobExecutionError(blocker);
      this.database.connection.prepare(blobRunUpdate).run(mode, this.now(), blob.id);
      return { blob: this.requireBlob(blob.id), already: false };
    });
  }

  private executionBlocker(blob: Blob): string | null {
    if (blob.state === "complete") return "This blob is complete.";
    if (this.hasRunningReceipt(blob.id)) return "A transition is already running.";
    if (!blob.paused) return null;
    const latest = this.listReceipts(blob.id).filter((receipt) => !receipt.invalidatedAt).at(-1);
    if (!latest) return "Inventory is held. Retry it before running.";
    if (latest.status === "failed") return "Retry the failed receipt before running.";
    if (blob.humanGateStepId === blob.state) return "Human feedback or approval is required before running.";
    return "Resolve the blocked step before running.";
  }

  private hasRunningReceipt(blobId: string): boolean {
    return Boolean(this.database.connection.prepare(runningReceiptByBlob).get(blobId));
  }

  private invalidateReceipts(
    blobId: string,
    target: StepDefinition,
    steps: StepDefinition[],
    at: string,
  ): number {
    const targetIndex = steps.findIndex((step) => step.id === target.id);
    const currentIds = new Set(steps.map((step) => step.id));
    const laterIds = new Set(steps.slice(targetIndex).map((step) => step.id));
    const receipts = this.listReceipts(blobId).filter((receipt) =>
      !receipt.invalidatedAt
      && (laterIds.has(receipt.stepId)
        || (!currentIds.has(receipt.stepId) && receipt.stepOrder >= target.order)));
    for (const receipt of receipts) {
      this.database.connection.prepare(receiptInvalidate).run(at, receipt.id);
    }
    return receipts.length;
  }

  private previousValidReceipt(
    blobId: string,
    target: StepDefinition,
    steps: StepDefinition[],
  ): Receipt | null {
    const targetIndex = steps.findIndex((step) => step.id === target.id);
    const receipts = this.listReceipts(blobId).filter((receipt) =>
      receipt.status === "advance" && !receipt.invalidatedAt);
    for (const step of steps.slice(0, targetIndex).reverse()) {
      const receipt = receipts.filter((candidate) => candidate.stepId === step.id).at(-1);
      if (receipt) return receipt;
    }
    return null;
  }

  private validAdvancedReceipts(blobId: string): Receipt[] {
    const rows = this.database.connection.prepare(validAdvancedReceiptList).all(blobId);
    return rows.map((row) => mapReceipt(asRecord(row)));
  }

  private nextAttempt(blobId: string, stepId: string): number {
    const row = this.database.connection.prepare(attemptSelect).get(blobId, stepId);
    return Number(asRecord(row).attempt);
  }

  private requireBlob(id: string): Blob {
    const blob = this.getBlob(id);
    if (!blob) throw new Error(`Blob ${id} was not found.`);
    return blob;
  }

  private requireProject(id: string): Project {
    const project = this.getProject(id);
    if (!project) throw new Error(`Project ${id} was not found.`);
    return project;
  }

  private persistWorkspaceRelocation(
    blob: Blob,
    project: Project,
    newRoot: string,
    evidence: string[],
  ): WorkspaceRelocation {
    if (blob.cwd === newRoot && project.root === newRoot) {
      throw new Error(`Blob ${blob.id} already uses workspace ${newRoot}.`);
    }
    const relocation = workspaceRelocation(blob, project, newRoot, evidence, this.now());
    this.database.connection.prepare(projectWorkspaceUpdate).run(newRoot, newRoot, relocation.createdAt, project.id);
    this.database.connection.prepare(blobWorkspaceUpdate).run(newRoot, relocation.createdAt, blob.id);
    this.database.connection.prepare(workspaceRelocationInsert).run(
      relocation.id, relocation.blobId, relocation.projectId,
      relocation.oldCwd, relocation.newCwd, relocation.oldProjectRoot, relocation.newProjectRoot,
      relocation.pipelineId, relocation.pipelinePath, JSON.stringify(relocation.evidence), relocation.createdAt,
    );
    const updated = this.requireBlob(blob.id);
    if (updated.pipelineId !== blob.pipelineId || updated.pipelinePath !== blob.pipelinePath) {
      throw new Error("Workspace relocation changed the blob pipeline identity.");
    }
    return relocation;
  }

  private requireReceipt(id: string): Receipt {
    const row = this.database.connection.prepare(receiptSelect).get(id);
    if (!row) throw new Error(`Receipt ${id} was not found.`);
    return mapReceipt(asRecord(row));
  }

  private requireActiveLease(ownerId?: string): void {
    if (!ownerId) return;
    const row = this.database.connection.prepare(activeLeaseSelect).get(ownerId, this.now());
    if (!row) throw new Error("The axi-factorio dispatcher lease was lost.");
  }

  private existingBlob(blob: Blob, input: BlobInput): BlobMutationResult {
    if (sameBlobInput(blob, input)) return { blob, already: true };
    throw new Error(`Blob ${blob.id} already exists with different input.`);
  }

  private ensureProject(id: string, input: ProjectInput, update = false): ProjectMutationResult {
    const existing = this.getProject(id);
    if (existing) {
      if (sameProjectInput(existing, input)) return { project: existing, already: true };
      if (!update) throw new Error(`Project ${id} already exists with different input.`);
      this.database.connection.prepare(projectUpdate).run(
        input.name, input.root, input.root, input.pipelineRoot, input.defaultPipeline, this.now(), id,
      );
      return { project: this.getProject(id)!, already: false };
    }
    const at = this.now();
    this.database.connection.prepare(projectInsert).run(
      id, input.name, input.root, input.root, input.pipelineRoot, input.defaultPipeline, at, at,
    );
    return { project: this.getProject(id)!, already: false };
  }
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    root: String(row.root || row.cwd),
    pipelineRoot: String(row.pipelineRoot),
    defaultPipeline: String(row.defaultPipeline),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function mapBlob(row: Record<string, unknown>): Blob {
  return {
    id: String(row.id),
    projectId: String(row.projectId || "default"),
    title: String(row.title),
    body: String(row.body),
    cwd: String(row.cwd),
    pipelineId: String(row.pipelineId || row.pipelinePath),
    pipelinePath: String(row.pipelinePath),
    inputArtifacts: JSON.parse(String(row.inputArtifactsJson)) as string[],
    state: row.state as BlobState,
    paused: Boolean(row.paused),
    executionMode: String(row.executionMode || "continuous") as ExecutionMode,
    runRequested: Boolean(row.runRequested),
    lastCompletedStepId: nullableString(row.lastCompletedStepId),
    lastCompletedOrder: nullableNumber(row.lastCompletedOrder),
    forcedStepId: nullableString(row.forcedStepId),
    humanGateStepId: nullableString(row.humanGateStepId),
    humanGateApprovalInputId: nullableString(row.humanGateApprovalInputId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function mapReceipt(row: Record<string, unknown>): Receipt {
  return {
    id: String(row.id),
    blobId: String(row.blobId),
    stepId: String(row.stepId),
    stepOrder: Number(row.stepOrder),
    attempt: Number(row.attempt),
    status: row.status as ReceiptStatus,
    executionKind: String(row.executionKind || "automated") as Receipt["executionKind"],
    adapter: String(row.adapter),
    attestationSource: nullableString(row.attestationSource),
    attestationEvidence: JSON.parse(String(row.attestationEvidenceJson || "[]")) as string[],
    definitionGitSha: String(row.definitionGitSha),
    definitionHash: String(row.definitionHash),
    inputArtifacts: JSON.parse(String(row.inputArtifactsJson)) as string[],
    outputArtifacts: JSON.parse(String(row.outputArtifactsJson)) as string[],
    externalRunId: nullableString(row.externalRunId),
    continuationThreadId: nullableString(row.continuationThreadId),
    humanInputs: JSON.parse(String(row.humanInputJson || "[]")) as HumanInput[],
    approvalEvidence: row.approvalEvidenceJson
      ? JSON.parse(String(row.approvalEvidenceJson)) as HumanInput
      : null,
    reason: nullableString(row.reason),
    error: nullableString(row.error),
    startedAt: String(row.startedAt),
    finishedAt: nullableString(row.finishedAt),
    invalidatedAt: nullableString(row.invalidatedAt),
  };
}

function executionEventFromRow(row: unknown): ExecutionEvent {
  const record = asRecord(row);
  return {
    id: Number(record.id),
    receiptId: String(record.receiptId),
    blobId: String(record.blobId),
    stepId: String(record.stepId),
    name: String(record.name),
    attributes: parseObject(record.attributesJson),
    createdAt: String(record.createdAt),
  };
}

function parseObject(value: unknown): Record<string, string | number | boolean> {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, string | number | boolean>;
}

function sameBlobInput(blob: Blob, input: BlobInput): boolean {
  return blob.title === input.title
    && blob.projectId === (input.projectId ?? "default")
    && blob.body === input.body
    && blob.cwd === input.cwd
    && blob.pipelineId === (input.pipelineId ?? input.pipelinePath)
    && blob.pipelinePath === input.pipelinePath
    && JSON.stringify(blob.inputArtifacts) === JSON.stringify(input.inputArtifacts);
}

function sameProjectInput(project: Project, input: ProjectInput): boolean {
  return project.name === input.name
    && project.root === input.root
    && project.pipelineRoot === input.pipelineRoot
    && project.defaultPipeline === input.defaultPipeline;
}

function mapHumanInput(row: Record<string, unknown>): HumanInput {
  return {
    id: String(row.id),
    blobId: String(row.blobId),
    stepId: String(row.stepId),
    kind: row.kind as HumanInputKind,
    text: String(row.text),
    evidence: JSON.parse(String(row.evidenceJson)) as string[],
    createdAt: String(row.createdAt),
    receiptId: nullableString(row.receiptId),
  };
}

function mapBlobRevision(row: Record<string, unknown>): BlobRevision {
  return {
    blobId: String(row.blobId),
    revision: Number(row.revision),
    title: String(row.title),
    body: String(row.body),
    contentHash: String(row.contentHash),
    createdAt: String(row.createdAt),
  };
}

function mapAttemptEvidence(row: Record<string, unknown>): AttemptEvidence {
  return {
    receiptId: String(row.receiptId),
    blobRevision: {
      blobId: String(row.blobId),
      revision: Number(row.blobRevision),
      title: String(row.blobTitle),
      body: String(row.blobBody),
      contentHash: String(row.blobContentHash),
      createdAt: String(row.createdAt),
    },
    definition: {
      gitSha: String(row.definitionGitSha),
      contentHash: String(row.definitionHash),
      entry: String(row.entryMarkdown),
      exit: String(row.exitMarkdown),
    },
    harness: String(row.harness),
    model: nullableString(row.model),
    inputArtifacts: JSON.parse(String(row.inputArtifactsJson)) as string[],
    createdAt: String(row.createdAt),
  };
}

function revisionHash(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`).digest("hex");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export type BlobMutationResult = { blob: Blob; already: boolean };
export type ProjectMutationResult = { project: Project; already: boolean };

export class BlobExecutionError extends Error {}

type BeginReceiptInput = {
  blobId: string;
  step: StepDefinition;
  definition: DefinitionSnapshot;
  adapter: string;
  model: string | null;
  inputArtifacts: string[];
};

const blobInsert = `INSERT INTO blobs
  (id, projectId, title, body, cwd, pipelineId, pipelinePath, inputArtifactsJson, state, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const blobSelect = "SELECT * FROM blobs WHERE id = ?";
const blobList = "SELECT * FROM blobs ORDER BY createdAt DESC, id ASC";
const blobContentUpdate = "UPDATE blobs SET title = ?, body = ?, updatedAt = ? WHERE id = ?";
const blobNext = `SELECT * FROM blobs WHERE state != 'complete' AND paused = 0 AND runRequested = 1
  AND NOT EXISTS (SELECT 1 FROM receipts WHERE receipts.blobId = blobs.id
    AND receipts.status = 'running' AND receipts.invalidatedAt IS NULL)
  ORDER BY updatedAt, createdAt LIMIT 1`;
const blobPauseAndRunUpdate = "UPDATE blobs SET paused = ?, runRequested = ?, updatedAt = ? WHERE id = ?";
const blobRunUpdate = "UPDATE blobs SET executionMode = ?, runRequested = 1, updatedAt = ? WHERE id = ?";
const blobStopUpdate = "UPDATE blobs SET runRequested = 0, updatedAt = ? WHERE id = ?";
const blobCompleteUpdate = `UPDATE blobs SET state = 'complete', paused = 0,
  runRequested = 0,
  forcedStepId = NULL, humanGateStepId = NULL, humanGateApprovalInputId = NULL,
  updatedAt = ? WHERE id = ?`;
const blobAdvanceUpdate = `UPDATE blobs SET state = ?, paused = ?, runRequested = ?, lastCompletedStepId = ?,
  lastCompletedOrder = ?, forcedStepId = NULL, humanGateStepId = NULL,
  humanGateApprovalInputId = NULL, updatedAt = ? WHERE id = ?`;
const blobRewindUpdate = `UPDATE blobs SET state = ?, paused = 0, lastCompletedStepId = ?,
  lastCompletedOrder = ?, forcedStepId = ?, humanGateStepId = NULL,
  humanGateApprovalInputId = NULL, runRequested = 0, updatedAt = ? WHERE id = ?`;
const blobHumanGateUpdate = `UPDATE blobs SET humanGateStepId = ?,
  humanGateApprovalInputId = ?, paused = ?, runRequested = ?, updatedAt = ? WHERE id = ?`;
const blobAdoptUpdate = `UPDATE blobs SET state = ?, paused = 0, lastCompletedStepId = ?,
  lastCompletedOrder = ?, forcedStepId = NULL, humanGateStepId = NULL,
  humanGateApprovalInputId = NULL, runRequested = 0, updatedAt = ? WHERE id = ?`;
const receiptInsert = `INSERT INTO receipts
  (id, blobId, stepId, stepOrder, attempt, status, adapter, definitionGitSha,
   definitionHash, inputArtifactsJson, outputArtifactsJson, continuationThreadId,
   humanInputJson, approvalEvidenceJson, startedAt)
  VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, '[]', ?, ?, ?, ?)`;
const importedReceiptInsert = `INSERT INTO receipts
  (id, blobId, stepId, stepOrder, attempt, status, executionKind, adapter,
   attestationSource, attestationEvidenceJson, definitionGitSha, definitionHash,
   inputArtifactsJson, outputArtifactsJson, reason, startedAt, finishedAt)
  VALUES (?, ?, ?, ?, 1, 'advance', 'imported', 'attested-import', ?, ?, ?, ?, ?, ?,
    'Imported completion attested; no automation was run.', ?, ?)`;
const receiptSelect = "SELECT * FROM receipts WHERE id = ?";
const receiptList = "SELECT * FROM receipts ORDER BY startedAt, stepOrder, attempt";
const receiptListByBlob = "SELECT * FROM receipts WHERE blobId = ? ORDER BY startedAt, stepOrder, attempt";
const blobRevisionInsert = `INSERT INTO blobRevisions
  (blobId, revision, title, body, contentHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)`;
const blobRevisionCurrent = `SELECT * FROM blobRevisions
  WHERE blobId = ? ORDER BY revision DESC LIMIT 1`;
const blobRevisionList = "SELECT * FROM blobRevisions WHERE blobId = ? ORDER BY revision";
const attemptEvidenceInsert = `INSERT INTO attemptEvidence
  (receiptId, blobRevision, blobTitle, blobBody, blobContentHash,
   definitionGitSha, definitionHash, entryMarkdown, exitMarkdown,
   harness, model, inputArtifactsJson, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const attemptEvidenceByBlob = `SELECT attemptEvidence.*, receipts.blobId
  FROM attemptEvidence JOIN receipts ON receipts.id = attemptEvidence.receiptId
  WHERE receipts.blobId = ? ORDER BY receipts.startedAt, receipts.attempt`;
const receiptExternalRunUpdate = "UPDATE receipts SET externalRunId = ? WHERE id = ?";
const receiptCompleteUpdate = `UPDATE receipts SET status = ?, outputArtifactsJson = ?,
  externalRunId = ?, reason = ?, finishedAt = ? WHERE id = ?`;
const receiptFailureUpdate = "UPDATE receipts SET status = 'failed', error = ?, finishedAt = ? WHERE id = ?";
const receiptInterruptUpdate = `UPDATE receipts SET status = 'interrupted',
  error = ?, finishedAt = ? WHERE id = ?`;
const receiptInvalidate = "UPDATE receipts SET invalidatedAt = ? WHERE id = ?";
const validAdvancedReceiptList = `SELECT * FROM receipts WHERE blobId = ?
  AND status = 'advance' AND invalidatedAt IS NULL ORDER BY stepOrder, finishedAt`;
const runningReceiptList = `SELECT receipts.* FROM receipts JOIN blobs ON blobs.id = receipts.blobId
  WHERE receipts.status = 'running' AND receipts.invalidatedAt IS NULL`;
const runningReceiptByBlob = `SELECT 1 FROM receipts WHERE blobId = ?
  AND status = 'running' AND invalidatedAt IS NULL LIMIT 1`;
const attemptSelect = "SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM receipts WHERE blobId = ? AND stepId = ?";
const receiptContinuationSelect = `SELECT externalRunId FROM receipts WHERE blobId = ?
  AND stepId = ? AND invalidatedAt IS NULL AND externalRunId IS NOT NULL
  ORDER BY attempt DESC LIMIT 1`;
const humanInputInsert = `INSERT INTO humanInputs
  (id, blobId, stepId, kind, text, evidenceJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const humanInputSelect = "SELECT * FROM humanInputs WHERE id = ?";
const humanInputList = "SELECT * FROM humanInputs ORDER BY createdAt, id";
const humanInputListByBlob = "SELECT * FROM humanInputs WHERE blobId = ? ORDER BY createdAt, id";
const humanInputPendingList = `SELECT * FROM humanInputs WHERE blobId = ? AND stepId = ?
  AND receiptId IS NULL ORDER BY createdAt, id`;
const humanInputReceiptUpdate = `UPDATE humanInputs SET receiptId = ?
  WHERE blobId = ? AND stepId = ? AND receiptId IS NULL`;
const executionEventsQuery = "SELECT * FROM executionEvents ORDER BY id";
const executionEventsByBlobQuery = "SELECT * FROM executionEvents WHERE blobId = ? ORDER BY id";
const executionEventInsert = `INSERT INTO executionEvents
  (receiptId, blobId, stepId, name, attributesJson, createdAt) VALUES (?, ?, ?, ?, ?, ?)`;
const workspaceRelocationInsert = `INSERT INTO workspaceRelocations
  (id, blobId, projectId, oldCwd, newCwd, oldProjectRoot, newProjectRoot,
   pipelineId, pipelinePath, evidenceJson, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const workspaceRelocationList = "SELECT * FROM workspaceRelocations ORDER BY createdAt, id";
const workspaceRelocationListByBlob = `SELECT * FROM workspaceRelocations
  WHERE blobId = ? ORDER BY createdAt, id`;
const blobWorkspaceUpdate = "UPDATE blobs SET cwd = ?, updatedAt = ? WHERE id = ?";
const projectWorkspaceUpdate = `UPDATE projects SET cwd = ?, root = ?, updatedAt = ? WHERE id = ?`;
const leaseDeleteExpired = "DELETE FROM dispatcherLeases WHERE name = 'runner' AND leaseUntil <= ?";
const leaseInsert = `INSERT OR IGNORE INTO dispatcherLeases
  (name, ownerId, leaseUntil, updatedAt) VALUES ('runner', ?, ?, ?)`;
const leaseRenew = `UPDATE dispatcherLeases SET leaseUntil = ?, updatedAt = ?
  WHERE name = 'runner' AND ownerId = ? AND leaseUntil > ?`;
const leaseRelease = "DELETE FROM dispatcherLeases WHERE name = 'runner' AND ownerId = ?";
const activeLeaseSelect = `SELECT 1 FROM dispatcherLeases
  WHERE name = 'runner' AND ownerId = ? AND leaseUntil > ?`;
const projectInsert = `INSERT INTO projects
  (id, name, cwd, root, pipelineRoot, defaultPipeline, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const projectUpdate = `UPDATE projects SET name = ?, cwd = ?, root = ?, pipelineRoot = ?,
  defaultPipeline = ?, updatedAt = ? WHERE id = ?`;
const projectSelect = "SELECT * FROM projects WHERE id = ?";
const projectList = "SELECT * FROM projects ORDER BY name, id";

function requireDirectory(path: string): string {
  const resolved = realpathSync(path);
  if (!statSync(resolved).isDirectory()) throw new Error(`Workspace target is not a directory: ${resolved}`);
  return resolved;
}

function workspaceRelocation(
  blob: Blob,
  project: Project,
  newRoot: string,
  evidence: string[],
  createdAt: string,
): WorkspaceRelocation {
  return {
    id: randomUUID(), blobId: blob.id, projectId: project.id,
    oldCwd: blob.cwd, newCwd: newRoot,
    oldProjectRoot: project.root, newProjectRoot: newRoot,
    pipelineId: blob.pipelineId, pipelinePath: blob.pipelinePath,
    evidence: [...evidence], createdAt,
  };
}

function mapWorkspaceRelocation(row: Record<string, unknown>): WorkspaceRelocation {
  return {
    id: String(row.id), blobId: String(row.blobId), projectId: String(row.projectId),
    oldCwd: String(row.oldCwd), newCwd: String(row.newCwd),
    oldProjectRoot: String(row.oldProjectRoot), newProjectRoot: String(row.newProjectRoot),
    pipelineId: String(row.pipelineId), pipelinePath: String(row.pipelinePath),
    evidence: JSON.parse(String(row.evidenceJson)) as string[], createdAt: String(row.createdAt),
  };
}

import type {
  ExecutionResult,
  ClaimedExecution,
  DefinitionSnapshot,
  ExecutionEvent,
  Receipt,
  ReceiptStatus,
  HumanInput,
  HumanInputKind,
  StepDefinition,
  Blob,
  BlobInput,
  BlobState,
  ExecutionMode,
  Project,
  ProjectInput,
  ImportAttestation,
  AttemptEvidence,
  BlobRevision,
  WorkspaceRelocation,
} from "./Types.ts";
import type { FactorioDatabase } from "./Database.ts";
import { createHash, randomUUID } from "node:crypto";
import { discoverPipeline } from "./Pipeline.ts";
import { dirname } from "node:path";
import { realpathSync, statSync } from "node:fs";
