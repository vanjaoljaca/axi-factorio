test("Workbench proves dispatcher ownership survives delayed provider allocation", async () => {
  const scenario = await runDispatcherAllocationScenario();
  const terminal = scenario.frames.at(-1)!;

  assert.equal(terminal.receipts[0]?.status, "advance");
  assert.equal(terminal.receipts[0]?.detail, "fixture:provider-task");
  assert(terminal.assertions.every((assertion) => assertion.passed));
});

import { runDispatcherAllocationScenario } from "../test/harness/DispatcherAllocationScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
