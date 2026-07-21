test("unchanged aggregate polling preserves marker node identity", () => {
  const marker = fakeMarker();
  const before = marker;
  const update = aggregateUpdate("stable");

  assert.equal(updateAggregateMarker(marker, update), true);
  assert.equal(updateAggregateMarker(marker, update), false);
  assert.strictEqual(marker, before);
  assert.equal(marker.styleWrites, 1);
  assert.equal(marker.attributeWrites, 1);
});

test("aggregate Viewer contract pins disclosure and exposes complete status counts", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "ViewerServer.ts"), "utf8");

  assert.match(source, /grid-template-columns:280px repeat\(var\(--steps\),minmax\(72px,1fr\)\) 36px/u);
  assert.match(source, /\.project-disclosure\{position:sticky;right:0/u);
  assert.match(source, /counts\.completed\+' completed/u);
  assert.match(source, /data-aggregate-key/u);
  assert.match(source, /patchOverview\(projects\)/u);
});

test("active-project classification includes every nonterminal state only", () => {
  assert.equal(projectHasActiveWork({ blobs: [] }), false);
  assert.equal(projectHasActiveWork({ blobs: [{ status: "complete" }] }), false);
  for (const status of ["ready", "queued", "held", "running", "waiting", "blocked", "failed"]) {
    assert.equal(projectHasActiveWork({ blobs: [{ status }] }), true, status);
  }
});

test("Viewer active-project fold keeps vertical scrolling on the document", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "ViewerServer.ts"), "utf8");

  assert.match(source, /Show all projects/u);
  assert.match(source, /\.workspace\{overflow-x:auto;overflow-y:visible\}/u);
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

type FakeMarker = AggregateMarker & { styleWrites: number; attributeWrites: number };

import type { AggregateMarker, AggregateMarkerUpdate } from "../src/ViewerComponents.ts";
import { projectHasActiveWork, updateAggregateMarker } from "../src/ViewerComponents.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
