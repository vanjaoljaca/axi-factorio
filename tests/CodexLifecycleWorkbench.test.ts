test("Workbench keeps a fresh active Codex turn alive through reconciliation", async () => {
  const scenario = await runCodexActiveTurnScenario();

  assert.equal(scenario.controlState, "running");
  assert.equal(scenario.staleState, "interrupted");
  assert.equal(scenario.staleRecovery, "resume");
  assert.equal(scenario.observedReceipt.status, "advance");
  assert(scenario.frames.at(-1)?.assertions.every((assertion) => assertion.passed));
});

import { runCodexActiveTurnScenario } from "../test/harness/CodexActiveTurnScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
