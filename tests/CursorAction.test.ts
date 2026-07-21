test("Cursor action targets the effective assigned workspace with argv and no shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio cursor --literal "));
  const calls: Array<{ executable: string; args: string[] }> = [];
  const launcher = new CursorWorkspaceLauncher(
    "/Applications/Cursor.app/cursor",
    async (executable, args) => void calls.push({ executable, args }),
  );
  try {
    const blob = cursorBlob("blob-assigned", join(root, "app"), root);
    assert.equal(launcher.inspect(blob).workspaceKind, "assigned-workspace");
    assert.deepEqual(await launcher.open(blob), { blobId: blob.id, root, opened: true });
    assert.deepEqual(calls, [{ executable: "/Applications/Cursor.app/cursor", args: [root] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor action treats the project root as the effective workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-project-root-"));
  try {
    const action = new CursorWorkspaceLauncher("/cursor", async () => {}).inspect(cursorBlob("blob-root", root, root));
    assert.equal(action.workspaceKind, "project-root");
    assert.equal(action.enabled, true);
    assert.equal(action.explanation, "Open the project root in Cursor.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor action makes missing workspaces and Cursor installation explicit", async () => {
  const missing = join(tmpdir(), "axi-factorio-missing-workspace");
  const missingAction = new CursorWorkspaceLauncher("/cursor", async () => {}).inspect(
    cursorBlob("blob-missing", missing, missing),
  );
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-no-cursor-"));
  const launcher = new CursorWorkspaceLauncher(null, async () => {});
  try {
    assert.equal(missingAction.enabled, false);
    assert.equal(missingAction.explanation, "Workspace folder does not exist.");
    assert.equal(launcher.inspect(cursorBlob("blob-no-cursor", root, root)).explanation, "Cursor is not installed or is unavailable.");
    await assert.rejects(launcher.open(cursorBlob("blob-no-cursor", root, root)), /Cursor is not installed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function cursorBlob(id: string, cwd: string, executionWorkspaceRoot: string): CursorBlob {
  return { id, cwd, executionWorkspaceRoot };
}

type CursorBlob = { id: string; cwd: string; executionWorkspaceRoot: string };

import { CursorWorkspaceLauncher } from "../src/CursorAction.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
