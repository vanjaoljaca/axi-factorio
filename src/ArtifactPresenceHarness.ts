export class ArtifactPresenceHarness implements AgentHarness {
  readonly name = "artifact-presence";

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    return verify(input, observer);
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return verify(input, observer);
  }

  async cancel(): Promise<void> {}
}

function verify(input: HarnessStartInput, observer: HarnessObserver): HarnessResult {
  const result = verifyArtifacts(input.definition.exit, input.blob.executionWorkspaceRoot);
  if (result.policy.kind !== "artifacts") throw new Error("The current step declares no local artifact links.");
  for (const artifactRef of result.present) observer.event({ type: "artifact", artifactRef });
  return {
    decision: result.missing.length ? "blocked" : "advance",
    reason: result.missing.length
      ? `Awaiting declared artifacts: ${result.missing.join(", ")}`
      : "Declared artifacts are present.",
    outputArtifacts: result.present,
    externalRunId: null,
  };
}

import type {
  AgentHarness,
  HarnessObserver,
  HarnessResult,
  HarnessResumeInput,
  HarnessStartInput,
} from "./Harness.ts";
import { verifyArtifacts } from "./ArtifactRules.ts";
