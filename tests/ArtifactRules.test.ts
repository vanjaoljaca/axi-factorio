test("blank exit is completion mode and ordinary Markdown links declare local artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-artifacts-"));
  mkdirSync(join(root, "artifacts"));
  writeFileSync(join(root, "artifacts", "plan.md"), "plan");

  assert.deepEqual(completionPolicy("  \n"), { kind: "completion" });
  assert.deepEqual(verifyArtifacts("[Plan](artifacts/plan.md)", root), {
    policy: { kind: "artifacts", requirements: ["artifacts/plan.md"] },
    present: [`file:${join(root, "artifacts", "plan.md")}`],
    missing: [],
  });
  assert.deepEqual(completionPolicy("Evaluate quality."), { kind: "classifier" });
});

test("artifact rules reject workspace escapes and report missing files without failing", () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-artifacts-"));
  assert.throws(() => verifyArtifacts("[Escape](../outside.md)", root), /escapes the execution workspace/);
  assert.deepEqual(verifyArtifacts("[Plan](artifacts/plan.md)", root).missing, ["artifacts/plan.md"]);
});

import { completionPolicy, verifyArtifacts } from "../src/ArtifactRules.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
