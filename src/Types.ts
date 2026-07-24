export type BlobState = string;
export type ExecutionMode = "continuous" | "step";
export type ReceiptStatus = "running" | "advance" | "retry" | "blocked" | "failed" | "interrupted";
export type HarnessDecision = "advance" | "retry" | "blocked";

export type StepDefinition = {
  id: string;
  order: number;
  entryPath: string;
  exitPath: string;
};

export type DefinitionSnapshot = {
  gitSha: string;
  contentHash: string;
  entry: string;
  exit: string;
};

export type ProjectInput = {
  name: string;
  root: string;
  pipelineRoot: string;
  defaultPipeline: string;
};

export type Project = ProjectInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type BlobInput = {
  title: string;
  body: string;
  cwd: string;
  executionWorkspaceRoot?: string;
  projectId?: string;
  pipelineId?: string;
  pipelinePath: string;
  inputArtifacts: string[];
};

export type Blob = Omit<BlobInput, "executionWorkspaceRoot" | "pipelineId" | "projectId"> & {
  id: string;
  projectId: string;
  pipelineId: string;
  executionWorkspaceRoot: string;
  state: BlobState;
  paused: boolean;
  executionMode: ExecutionMode;
  runRequested: boolean;
  singleTransitionRequested: boolean;
  lastCompletedStepId: string | null;
  lastCompletedOrder: number | null;
  forcedStepId: string | null;
  humanGateStepId: string | null;
  humanGateApprovalInputId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BlobRevision = {
  blobId: string;
  revision: number;
  title: string;
  body: string;
  contentHash: string;
  createdAt: string;
};

export type AttemptEvidence = {
  receiptId: string;
  blobRevision: BlobRevision;
  definition: DefinitionSnapshot;
  harness: string;
  model: string | null;
  inputArtifacts: string[];
  createdAt: string;
};

export type HumanInputKind = "review" | "feedback" | "approval";

export type HumanInput = {
  id: string;
  blobId: string;
  stepId: string;
  kind: HumanInputKind;
  text: string;
  evidence: string[];
  createdAt: string;
  receiptId: string | null;
};

export type Receipt = {
  id: string;
  blobId: string;
  stepId: string;
  stepOrder: number;
  attempt: number;
  status: ReceiptStatus;
  executionKind: "automated" | "human" | "imported";
  adapter: string;
  model: string | null;
  reasoningEffort: string | null;
  attestationSource: string | null;
  attestationEvidence: string[];
  definitionGitSha: string;
  definitionHash: string;
  inputArtifacts: string[];
  outputArtifacts: string[];
  externalRunId: string | null;
  continuationThreadId: string | null;
  humanInputs: HumanInput[];
  approvalEvidence: HumanInput | null;
  reason: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string;
  lastProgressAt: string;
  currentOperation: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  finishedAt: string | null;
  invalidatedAt: string | null;
};

export type ExecutionEvent = {
  id: number;
  receiptId: string;
  blobId: string;
  stepId: string;
  name: string;
  attributes: Record<string, string | number | boolean>;
  createdAt: string;
};

export type WorkspaceRelocation = {
  id: string;
  blobId: string;
  projectId: string;
  oldCwd: string;
  newCwd: string;
  oldProjectRoot: string;
  newProjectRoot: string;
  pipelineId: string;
  pipelinePath: string;
  evidence: string[];
  createdAt: string;
};

export type ExecutionWorkspaceBinding = {
  id: string;
  blobId: string;
  projectId: string;
  projectRoot: string;
  oldExecutionWorkspaceRoot: string;
  newExecutionWorkspaceRoot: string;
  pipelineId: string;
  pipelinePath: string;
  evidence: string[];
  createdAt: string;
};

export type LocalEndpointLease = {
  id: string;
  blobId: string;
  stepId: string;
  receiptId: string;
  workspaceRoot: string;
  gitHead: string;
  url: string;
  port: number;
  pid: number;
  command: string;
  args: string[];
  ownership: "receipt" | "human-decision";
  desiredState: "active" | "stopped";
  observedState: "healthy" | "stopping" | "stopped" | "failed";
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
};

export type LocalEndpointDeclaration = {
  blobId: string;
  workspaceRoot: string;
  command: string;
  args: string[];
  healthPath: string;
  createdAt: string;
  updatedAt: string;
};

export type ImportAttestation = {
  step: StepDefinition;
  definition: DefinitionSnapshot;
  evidence: string[];
};

export type ClaimedExecution = {
  blob: Blob;
  receipt: Receipt;
  step: StepDefinition;
  definition: DefinitionSnapshot;
};

export type ExecutionResult = {
  status: HarnessDecision;
  reason: string;
  outputArtifacts: string[];
  externalRunId: string | null;
};
