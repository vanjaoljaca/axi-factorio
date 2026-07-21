export class CursorWorkspaceLauncher {
  private readonly executable: string | null;
  private readonly execute: CursorExecutor;
  private readonly directoryExists: DirectoryExists;

  constructor(
    executable = findCursorExecutable(),
    execute: CursorExecutor = executeCursor,
    directoryExists: DirectoryExists = isDirectory,
  ) {
    this.executable = executable;
    this.execute = execute;
    this.directoryExists = directoryExists;
  }

  inspect(blob: CursorBlob): CursorActionState {
    const root = resolve(blob.executionWorkspaceRoot);
    const workspaceKind = root === resolve(blob.cwd) ? "project-root" : "assigned-workspace";
    if (!this.directoryExists(root)) return unavailable(root, workspaceKind, "Workspace folder does not exist.");
    if (!this.executable) return unavailable(root, workspaceKind, "Cursor is not installed or is unavailable.");
    return ready(root, workspaceKind);
  }

  async open(blob: CursorBlob): Promise<CursorOpenResult> {
    const action = this.inspect(blob);
    if (!action.enabled || !this.executable) throw new CursorLaunchError(action.explanation);
    try {
      await this.execute(this.executable, [action.root]);
      log("viewer.cursor_opened", { blobId: blob.id, workspaceRoot: action.root });
      return { blobId: blob.id, root: action.root, opened: true };
    } catch (error) {
      log("viewer.cursor_open_failed", {
        blobId: blob.id, workspaceRoot: action.root,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export class CursorLaunchError extends Error {}

export function findCursorExecutable(pathValue = process.env.PATH ?? ""): string | null {
  const candidates = [cursorApplicationCli, ...pathValue.split(delimiter).map((root) => join(root, "cursor"))];
  return candidates.find(isExecutable) ?? null;
}

function ready(root: string, workspaceKind: CursorWorkspaceKind): CursorActionState {
  return {
    enabled: true, root, workspaceKind, label: "Open in Cursor",
    explanation: workspaceKind === "project-root"
      ? "Open the project root in Cursor."
      : "Open the assigned execution workspace in Cursor.",
  };
}

function unavailable(
  root: string,
  workspaceKind: CursorWorkspaceKind,
  explanation: string,
): CursorActionState {
  return { enabled: false, root, workspaceKind, label: "Unavailable", explanation };
}

function executeCursor(executable: string, args: string[]): Promise<void> {
  return new Promise((resolveExecution, rejectExecution) => {
    execFile(executable, args, { timeout: 15_000 }, (error) => {
      if (error) rejectExecution(new CursorLaunchError(`Cursor could not be opened: ${error.message}`));
      else resolveExecution();
    });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type CursorActionState = {
  enabled: boolean;
  root: string;
  workspaceKind: CursorWorkspaceKind;
  label: "Open in Cursor" | "Unavailable";
  explanation: string;
};
export type CursorOpenResult = { blobId: string; root: string; opened: true };
type CursorWorkspaceKind = "assigned-workspace" | "project-root";
type CursorBlob = Pick<Blob, "id" | "cwd" | "executionWorkspaceRoot">;
type CursorExecutor = (executable: string, args: string[]) => Promise<void>;
type DirectoryExists = (path: string) => boolean;

const cursorApplicationCli = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";

import type { Blob } from "./Types.ts";
import { log } from "./Logger.ts";
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
