export interface AgentHarness {
  readonly name: string;
  start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult>;
  resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult>;
  cancel(input: HarnessCancelInput): Promise<void>;
}

export type HarnessStartInput = HarnessRunInput;
export type HarnessResumeInput = HarnessRunInput & { externalRunId: string };

export type HarnessRunInput = {
  runId: string;
  blob: Blob;
  step: StepDefinition;
  definition: DefinitionSnapshot;
  inputArtifacts: string[];
  humanInputs: HumanInput[];
  approvalEvidence: HumanInput | null;
};

export type HarnessCancelInput = {
  runId: string;
  externalRunId: string | null;
  reason: string;
};

export type HarnessResult = {
  decision: HarnessDecision;
  reason: string;
  outputArtifacts: string[];
  externalRunId: string | null;
};

export type HarnessEvent =
  | { type: "status"; status: string; message?: string }
  | { type: "external-run"; externalRunId: string }
  | { type: "artifact"; artifactRef: string };

export type HarnessObserver = {
  event(event: HarnessEvent): void;
};

export function assertAgentHarness(value: unknown): AgentHarness {
  const harness = value as Partial<AgentHarness> | null;
  if (!harness || typeof harness.name !== "string" || !harness.name.trim()) {
    throw new Error("Harness must expose a non-empty name.");
  }
  for (const method of ["start", "resume", "cancel"] as const) {
    if (typeof harness[method] !== "function") throw new Error(`Harness must implement ${method}().`);
  }
  return harness as AgentHarness;
}

import type {
  HarnessDecision,
  Blob,
  DefinitionSnapshot,
  HumanInput,
  StepDefinition,
} from "./Types.ts";
