test("generic fake harness emits persisted lifecycle events without telemetry configured", async () => {
  const pipeline = createPipeline(["g1.first"]);
  const database = new FactorioDatabase(join(pipeline.root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  store.createBlob("blob-1", blobInput(pipeline));
  store.requestStep("blob-1");

  await new ConveyorRunner(store, new MockAgentHarness()).runOnce();

  const receipt = store.listReceipts("blob-1")[0];
  const events = store.listExecutionEvents("blob-1");
  assert.equal(receipt.adapter, "deterministic-mock");
  assert.equal(receipt.externalRunId, "mock-run:blob-1:g1.first");
  assert(events.some((event) => event.name === "axi_factorio.harness.start"));
  assert(events.some((event) => event.name === "axi_factorio.harness.terminal"));
  database.close();
});

test("external harness and instrumentation modules load through stable contracts", async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-harness-module-"));
  const modulePath = join(root, "harness.mjs");
  writeFileSync(modulePath, `
export function createHarness() {
  return {
    name: "external-test",
    start: async () => ({ decision: "advance", reason: "ok", outputArtifacts: [], externalRunId: "ext:1" }),
    resume: async input => ({ decision: "advance", reason: "ok", outputArtifacts: [], externalRunId: input.externalRunId }),
    cancel: async () => {}
  };
}
export function createInstrumentation() { return { record() {} }; }
`);

  const harness = await loadHarness(`module:${modulePath}`);
  const instrumentation = await loadHarnessInstrumentation(`module:${modulePath}`);

  assert.equal(harness.name, "external-test");
  assert.doesNotThrow(() => instrumentation.record({
    name: "axi_factorio.harness.start", timestamp: new Date().toISOString(), attributes: {},
  }));
});

test("Codex and mock implementations satisfy the same harness contract", () => {
  assert.equal(assertAgentHarness(new MockAgentHarness()).name, "deterministic-mock");
  assert.equal(assertAgentHarness(new CodexHarness()).name, "codex");
});

function blobInput(pipeline: PipelineFixture): BlobInput {
  return {
    title: "Harness contract", body: "", cwd: pipeline.root,
    pipelinePath: pipeline.pipelinePath, inputArtifacts: [],
  };
}

import type { BlobInput } from "../src/Types.ts";
import type { PipelineFixture } from "./Fixtures.ts";
import { assertAgentHarness } from "../src/Harness.ts";
import { loadHarness, loadHarnessInstrumentation } from "../src/HarnessLoader.ts";
import { CodexHarness } from "../src/CodexHarness.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorRunner } from "../src/Runner.ts";
import { ConveyorStore } from "../src/Store.ts";
import { MockAgentHarness } from "../test/harness/MockHarness.ts";
import { createPipeline } from "./Fixtures.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
