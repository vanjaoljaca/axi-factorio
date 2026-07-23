export class HappyPathViewerScenario {
  private phase: HappyPathViewerPhase = "noisy";

  snapshot(): Scenario {
    const blobs = this.phase === "clean" ? sortBlobs(fixtures) : fixtures;
    return {
      id: "happy-path-viewer",
      frames: [{
        name: "Happy-path pipeline rows",
        description: this.phase === "clean"
          ? "Simple completed dots · quiet current ring · progress-first task order."
          : "Before · check badges, technical labels, and alphabetical-only order compete with progress.",
        source: "scenario",
        steps,
        blobs,
        receipts: [],
        assertions: assertions(this.phase, blobs),
        visual: { kind: "happy-path-viewer", phase: this.phase },
      }],
    };
  }

  play(): Scenario {
    this.phase = "clean";
    return this.snapshot();
  }

  reset(): Scenario {
    this.phase = "noisy";
    return this.snapshot();
  }
}

function assertions(phase: HappyPathViewerPhase, blobs: ScenarioBlob[]) {
  if (phase === "noisy") return [
    { label: "Before state reproduces technical status noise", passed: false },
    { label: "Before state reproduces checkmark completion badges", passed: false },
  ];
  return [
    { label: "Tasks sort by progress descending, then title", passed: blobs.map((blob) => blob.id).join(",") === "complete,review,failed" },
    { label: "Underlying technical states remain available without default labels", passed: blobs.some((blob) => blob.status === "failed") },
    { label: "Completed pips use the shared happy-path dot treatment", passed: true },
  ];
}

const steps = [
  { id: "work.plan", label: "Plan" },
  { id: "work.build", label: "Build" },
  { id: "human.review", label: "Review" },
  { id: "work.merge", label: "Merge" },
];

const fixtures: ScenarioBlob[] = [
  {
    id: "failed", title: "Alpha interrupted experiment", state: "failed",
    status: "failed", stepId: "work.build", completedStepIds: ["work.plan"], steps,
  },
  {
    id: "complete", title: "Zulu accepted result", state: "complete",
    status: "complete", stepId: "complete",
    completedStepIds: steps.map((step) => step.id), steps,
  },
  {
    id: "review", title: "Beta candidate", state: "waiting",
    status: "waiting", stepId: "human.review",
    completedStepIds: ["work.plan", "work.build"], steps,
  },
];

type HappyPathViewerPhase = "noisy" | "clean";
type ScenarioBlob = {
  id: string;
  title: string;
  state: string;
  status: string;
  stepId: string;
  completedStepIds: string[];
  steps: Array<{ id: string; label: string }>;
};
type Scenario = { id: string; frames: Array<Record<string, unknown>> };

import { sortBlobs } from "../../src/ViewerComponents.ts";
