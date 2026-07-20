test("harness grants only required Git metadata writes outside its assigned directory", async () => {
  const scenario = await runGitMetadataBoundaryFixture();

  assert.equal(scenario.receipts.at(-1)?.status, "advance");
  assert.notEqual(scenario.beforeHead, scenario.afterHead);
  assert.deepEqual(scenario.files, { app: true, sibling: true, outside: false });
  assert(scenario.frames.at(-1)?.assertions.every((assertion) => assertion.passed));
});

import { runGitMetadataBoundaryFixture } from "../test/harness/GitMetadataBoundaryFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
