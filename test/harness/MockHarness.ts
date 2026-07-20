export class MockAgentHarness implements AgentHarness {
  readonly name = "deterministic-mock";
  private nextFailure = false;
  private nextRetry = false;
  private active = new Map<string, () => void>();
  private readonly delayMs: number;

  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  failNext(): void {
    this.nextFailure = true;
  }

  retryNext(): void {
    this.nextRetry = true;
  }

  async start(input: HarnessStartInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, observer, this.externalRunId(input));
  }

  async resume(input: HarnessResumeInput, observer: HarnessObserver): Promise<HarnessResult> {
    return this.execute(input, observer, input.externalRunId);
  }

  async cancel(input: HarnessCancelInput): Promise<void> {
    this.active.get(input.runId)?.();
  }

  private async execute(
    input: HarnessStartInput,
    observer: HarnessObserver,
    externalRunId: string,
  ): Promise<HarnessResult> {
    this.active.set(input.runId, () => undefined);
    observer.event({ type: "status", status: "started", message: input.step.id });
    observer.event({ type: "external-run", externalRunId });
    try {
      await this.delay(input.runId);
      if (this.nextFailure) return this.throwFailure();
      const decision = this.decision(input);
      const artifactRef = `mock-artifact:${input.blob.id}:${input.step.id}:${decision}`;
      observer.event({ type: "artifact", artifactRef });
      observer.event({ type: "status", status: decision, message: "deterministic terminal" });
      return {
        decision,
        reason: `mock ${decision} at ${input.step.id}`,
        outputArtifacts: [artifactRef],
        externalRunId,
      };
    } finally {
      this.active.delete(input.runId);
    }
  }

  private decision(input: HarnessStartInput): HarnessDecision {
    if (this.nextRetry) {
      this.nextRetry = false;
      return "retry";
    }
    if (input.step.id === "review.human" && !input.approvalEvidence) return "blocked";
    return "advance";
  }

  private throwFailure(): never {
    this.nextFailure = false;
    throw new Error("deterministic mock failure");
  }

  private externalRunId(input: HarnessStartInput): string {
    return `mock-run:${input.blob.id}:${input.step.id}`;
  }

  private async delay(runId: string): Promise<void> {
    if (!this.delayMs) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.delayMs);
      this.active.set(runId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

import type {
  AgentHarness,
  HarnessCancelInput,
  HarnessObserver,
  HarnessResult,
  HarnessResumeInput,
  HarnessStartInput,
} from "../../src/Harness.ts";
import type { HarnessDecision } from "../../src/Types.ts";
