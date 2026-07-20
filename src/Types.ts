export type BlobState = string;
export type ExecutionMode = "continuous" | "step";
export type ReceiptStatus = "running" | "advance" | "retry" | "blocked" | "failed" | "interrupted";
export type AdapterOutcome = "advance" | "retry" | "blocked";

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
  projectId?: string;
  pipelineId?: string;
  pipelinePath: string;
  inputArtifacts: string[];
};

export type Blob = Omit<BlobInput, "pipelineId" | "projectId"> & {
  id: string;
  projectId: string;
  pipelineId: string;
  state: BlobState;
  paused: boolean;
  executionMode: ExecutionMode;
  runRequested: boolean;
  lastCompletedStepId: string | null;
  lastCompletedOrder: number | null;
  forcedStepId: string | null;
  humanGateStepId: string | null;
  humanGateApprovalInputId: string | null;
  createdAt: string;
  updatedAt: string;
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
  executionKind: "automated" | "imported";
  adapter: string;
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
  startedAt: string;
  finishedAt: string | null;
  invalidatedAt: string | null;
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

export type AdapterInput = {
  blob: Blob;
  step: StepDefinition;
  definition: DefinitionSnapshot;
  inputArtifacts: string[];
  continuationThreadId: string | null;
  humanInputs: HumanInput[];
  approvalEvidence: HumanInput | null;
  signal?: AbortSignal;
};

export type AdapterResult = {
  status: AdapterOutcome;
  reason: string;
  outputArtifacts: string[];
  externalRunId: string | null;
};
