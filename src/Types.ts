export type BlobState = string;
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

export type BlobInput = {
  title: string;
  body: string;
  cwd: string;
  pipelineId?: string;
  pipelinePath: string;
  inputArtifacts: string[];
};

export type Blob = Omit<BlobInput, "pipelineId"> & {
  id: string;
  pipelineId: string;
  state: BlobState;
  paused: boolean;
  lastCompletedStepId: string | null;
  lastCompletedOrder: number | null;
  forcedStepId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Receipt = {
  id: string;
  blobId: string;
  stepId: string;
  stepOrder: number;
  attempt: number;
  status: ReceiptStatus;
  adapter: string;
  definitionGitSha: string;
  definitionHash: string;
  inputArtifacts: string[];
  outputArtifacts: string[];
  externalRunId: string | null;
  reason: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  invalidatedAt: string | null;
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
  signal?: AbortSignal;
};

export type AdapterResult = {
  status: AdapterOutcome;
  reason: string;
  outputArtifacts: string[];
  externalRunId: string | null;
};
