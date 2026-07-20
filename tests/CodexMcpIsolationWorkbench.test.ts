test("Workbench proves unrelated MCP startup cannot block a Codex stage", async () => {
  const scenario = await runCodexMcpIsolationScenario();

  assert.equal(scenario.observedReceipt.status, "advance");
  assert(scenario.argv.split("\n").includes("--ignore-user-config"));
  assert.match(scenario.frames[0]?.name ?? "", /Pinned Codex 0\.144\.6/);
  assert(scenario.frames.at(-1)?.assertions.every((assertion) => assertion.passed));
});

import { runCodexMcpIsolationScenario } from "../test/harness/CodexMcpIsolationScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
