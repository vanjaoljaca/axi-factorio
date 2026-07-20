export interface HarnessInstrumentation {
  record(event: HarnessBoundaryEvent): void;
}

export type HarnessBoundaryEvent = {
  name: `axi_factorio.harness.${HarnessBoundaryPhase}`;
  timestamp: string;
  attributes: Record<string, string | number | boolean>;
};

export type HarnessBoundaryPhase =
  | "start"
  | "resume"
  | "reconcile"
  | "event"
  | "terminal"
  | "cancel_requested"
  | "cancelled"
  | "error";

export const noHarnessInstrumentation: HarnessInstrumentation = {
  record: () => undefined,
};

export function assertHarnessInstrumentation(value: unknown): HarnessInstrumentation {
  const instrumentation = value as Partial<HarnessInstrumentation> | null;
  if (!instrumentation || typeof instrumentation.record !== "function") {
    throw new Error("Harness instrumentation must implement record().");
  }
  return instrumentation as HarnessInstrumentation;
}
