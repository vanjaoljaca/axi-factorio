test("unchanged aggregate polling preserves marker node identity", () => {
  const marker = fakeMarker();
  const before = marker;
  const update = aggregateUpdate("stable");

  assert.equal(updateAggregateMarker(marker, update), true);
  assert.equal(updateAggregateMarker(marker, update), false);
  assert.strictEqual(marker, before);
  assert.equal(marker.styleWrites, 2);
  assert.equal(marker.attributeWrites, 1);
});

test("aggregate Viewer contract pins disclosure and exposes complete status counts", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "ViewerServer.ts"), "utf8");

  assert.match(source, /\.taskrow\{grid-template-columns:280px repeat\(var\(--steps\),minmax\(72px,1fr\)\) 30px/u);
  assert.match(source, /\.project-disclosure\{position:sticky;right:0/u);
  assert.match(source, /counts\.completed\+' completed/u);
  assert.match(source, /data-aggregate-key/u);
  assert.match(source, /patchOverview\(projects\)/u);
});

test("active-project classification uses meaningful activity with attention overrides", () => {
  const now = new Date("2026-07-22T00:00:00Z");
  assert.equal(projectHasActiveWork(project([]), now), false);
  assert.equal(projectHasActiveWork(project([blob("complete", "2026-07-22T00:00:00Z")]), now), false);
  assert.equal(projectHasActiveWork(project([blob("held", "2026-07-21T00:00:00Z")]), now), true);
  assert.equal(projectHasActiveWork(project([blob("held", "2026-07-01T00:00:00Z")]), now), false);
  for (const status of ["queued", "running", "waiting", "blocked", "failed"]) {
    assert.equal(projectHasActiveWork(project([blob(status, "2026-01-01T00:00:00Z")]), now), true, status);
  }
});

test("continuous aggregate arcs start at noon and contain no separator gaps", () => {
  assert.equal(aggregateProgressGradient(0, 4), "conic-gradient(from -90deg, #aeb7b1 0deg 360deg)");
  assert.match(aggregateProgressGradient(1, 4), /var\(--green\) 0deg 90deg, #aeb7b1 90deg 360deg/u);
  assert.match(aggregateProgressGradient(2, 4), /0deg 180deg, #aeb7b1 180deg 360deg/u);
  assert.match(aggregateProgressGradient(3, 4), /0deg 270deg, #aeb7b1 270deg 360deg/u);
  assert.equal(aggregateProgressGradient(4, 4), "conic-gradient(from -90deg, var(--green) 0deg 360deg)");
  assert.doesNotMatch(aggregateProgressGradient(1, 4), /#fff|white/u);
});

test("progress sorting is deterministic and can be disabled", () => {
  const alpha = project([blob("ready", "2026-07-22T00:00:00Z", 1)], "a", "Alpha");
  const beta = project([blob("ready", "2026-07-22T00:00:00Z", 3)], "b", "Beta");
  assert.deepEqual(sortProjects([alpha, beta], true).map((item) => item.id), ["b", "a"]);
  assert.deepEqual(sortProjects([beta, alpha], false).map((item) => item.id), ["a", "b"]);
});

test("Viewer active-project fold keeps vertical scrolling on the document", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "ViewerServer.ts"), "utf8");

  assert.match(source, /Show all projects/u);
  assert.match(source, /\.workspace:not\(\.plain\)\{overflow-y:clip\}/u);
  assert.match(source, /projectHasActiveWork/u);
  assert.doesNotMatch(source, /\.workspace\{[^}]*overflow-y:(auto|scroll)/u);
});

function fakeMarker(): FakeMarker {
  const marker = {
    dataset: {}, title: "", styleWrites: 0, attributeWrites: 0,
    classList: { toggle: () => undefined },
    style: { setProperty: () => { marker.styleWrites += 1; } },
    setAttribute: () => { marker.attributeWrites += 1; },
  };
  return marker;
}

function aggregateUpdate(signature: string): AggregateMarkerUpdate {
  return {
    signature,
    composition: "conic-gradient(#0caf69 0deg 90deg, #aeb7b1 90deg 360deg)",
    label: "Plan — 4 tasks: 1 completed, 0 running, 0 need attention, 0 failed, 3 unfinished or inventory",
    total: 4,
  };
}

function blob(status: string, createdAt: string, complete = 0) {
  return { status, createdAt, latestReceiptAt: null, latestHumanInputAt: null,
    completedStepIds: Array.from({ length: complete }, (_, index) => String(index)),
    steps: [{ id: "0" }, { id: "1" }, { id: "2" }, { id: "3" }] };
}

function project(blobs: ReturnType<typeof blob>[], id = "project", name = "Project") {
  return { id, name, blobs };
}

type FakeMarker = AggregateMarker & { styleWrites: number; attributeWrites: number };

import type { AggregateMarker, AggregateMarkerUpdate } from "../src/ViewerComponents.ts";
import { aggregateProgressGradient, projectHasActiveWork, sortProjects, updateAggregateMarker } from "../src/ViewerComponents.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
