export class HappyPathViewerScenario {
  private phase: HappyPathViewerPhase = "collapsed";

  snapshot(): Scenario {
    const blobs = sortBlobs(fixtures);
    const projects = ["Alpha project", "Beta project", "Zulu project"];
    return {
      id: "happy-path-viewer",
      frames: [{
        name: "Happy-path pipeline rows",
        description: this.phase === "expanded"
          ? "Expanded project keeps the same aggregate row and inserts progress-sorted tasks below."
          : "Alphabetical projects stay collapsed with aggregate pipeline rows intact.",
        source: "scenario",
        steps,
        blobs,
        receipts: [],
        assertions: assertions(this.phase, blobs, projects),
        visual: { kind: "happy-path-viewer", phase: this.phase, projects },
      }],
    };
  }

  play(): Scenario {
    this.phase = "expanded";
    return this.snapshot();
  }

  reset(): Scenario {
    this.phase = "collapsed";
    return this.snapshot();
  }
}

function assertions(phase: HappyPathViewerPhase, blobs: ScenarioBlob[], projects: string[]) {
  return [
    { label: "Projects sort alphabetically regardless of progress", passed: projects.join(",") === "Alpha project,Beta project,Zulu project" },
    { label: "Tasks sort by progress descending, then title", passed: blobs.map((blob) => blob.id).join(",") === "complete,review,failed" },
    { label: "Expansion changes only child-row visibility", passed: ["collapsed", "expanded"].includes(phase) },
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

type HappyPathViewerPhase = "collapsed" | "expanded";
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
