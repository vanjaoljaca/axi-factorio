test("service PATH prefers the consuming workspace's pinned Codex CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-service-path-"));
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), "");
  try {
    assert.equal(servicePath(root, "/runtime/node"), `${dirname("/runtime/node")}:${bin}:/usr/bin:/bin`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { servicePath } from "../src/ServiceInstall.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
