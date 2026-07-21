test("Workbench visibly operates the configured opener title menu and unavailable state", async () => {
  const scenario = new CursorActionScenario();
  try {
    const ready = scenario.snapshot().frames[0].visual;
    assert.deepEqual(ready.rows.map((row) => [row.workspaceKind, row.action.enabled]), [
      ["assigned-workspace", true], ["project-root", true],
      ["project-root", true], ["project-root", false],
    ]);
    assert.match(ready.rows[0].triggerHtml, /data-blob-menu="assigned"/u);
    assert.match(ready.menuHtml, /role="menu"/u);
    assert.equal(ready.openerLabel, "Cursor");
    assert.equal(ready.rows[3].action.enabled, false);

    const opened = (await scenario.play()).frames[0].visual;
    assert.equal(opened.calls, 1);
    assert.match(opened.lastResult, /assigned-workspace/u);

    const failed = (await scenario.open("failure")).frames[0].visual;
    assert.match(failed.lastResult, /Failed: Cursor launch failed/u);

    const reset = scenario.reset().frames[0].visual;
    assert.equal(reset.calls, 0);
  } finally {
    scenario.dispose();
  }
});

import { CursorActionScenario } from "../test/harness/CursorActionScenario.ts";
import assert from "node:assert/strict";
import test from "node:test";
