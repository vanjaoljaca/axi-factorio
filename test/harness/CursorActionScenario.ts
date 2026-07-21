export class CursorActionScenario {
  private readonly root = mkdtempSync(join(tmpdir(), "axi-factorio-cursor-scenario-"));
  private readonly assignedRoot = join(this.root, "assigned-workspace");
  private readonly projectRoot = join(this.root, "project-root");
  private readonly failureRoot = join(this.root, "launch-failure");
  private readonly missingRoot = join(this.root, "missing-workspace");
  private readonly calls: CursorCall[] = [];
  private readonly launcher: CursorWorkspaceLauncher;
  private lastResult = "Ready to open a workspace.";

  constructor() {
    mkdirSync(this.assignedRoot);
    mkdirSync(this.projectRoot);
    mkdirSync(this.failureRoot);
    this.launcher = new CursorWorkspaceLauncher("/Applications/Cursor.app/cursor", async (executable, args) => {
      this.calls.push({ executable, args });
      if (args[0] === this.failureRoot) throw new CursorLaunchError("Cursor launch failed in the fixture.");
    });
  }

  snapshot(): Scenario {
    return { id: scenarioId, frames: [this.frame()] };
  }

  async play(): Promise<Scenario> {
    await this.open("assigned");
    return this.snapshot();
  }

  async open(id: string): Promise<Scenario> {
    const blob = this.blobs().find((candidate) => candidate.id === id);
    if (!blob) throw new Error(`Unknown Cursor scenario blob: ${id}`);
    try {
      const result = await this.launcher.open(blob);
      this.lastResult = `Opened ${result.root}`;
    } catch (error) {
      this.lastResult = `Failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.snapshot();
  }

  reset(): Scenario {
    this.calls.length = 0;
    this.lastResult = "Ready to open a workspace.";
    return this.snapshot();
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  private frame(): WorkbenchFrame {
    const rows = this.blobs().map((blob) => this.row(blob));
    return {
      name: "Open workspace in Cursor",
      description: "Real action state + safe fake launcher · Play or use the actual row action · Reset",
      source: "scenario", steps: [], blobs: [], receipts: [],
      assertions: this.assertions(rows),
      evidenceCards: [{
        label: "Captured argv",
        value: this.calls.map((call) => `${call.executable}\n${JSON.stringify(call.args)}`).join("\n") || "No launch yet",
      }],
      visual: { kind: "cursor-action", rows, lastResult: this.lastResult, calls: this.calls.length },
    };
  }

  private row(blob: ScenarioBlob): CursorScenarioRow {
    const action = this.launcher.inspect(blob);
    return {
      id: blob.id, title: blob.title, root: action.root, workspaceKind: action.workspaceKind,
      action, actionHtml: cursorActionMarkup(blob.id, action),
    };
  }

  private blobs(): ScenarioBlob[] {
    return [
      { id: "assigned", title: "Assigned workspace", cwd: join(this.root, "app"), executionWorkspaceRoot: this.assignedRoot },
      { id: "project", title: "Project root workspace", cwd: this.projectRoot, executionWorkspaceRoot: this.projectRoot },
      { id: "failure", title: "Cursor launch failure", cwd: this.failureRoot, executionWorkspaceRoot: this.failureRoot },
      { id: "missing", title: "Stale workspace", cwd: this.missingRoot, executionWorkspaceRoot: this.missingRoot },
    ];
  }

  private assertions(rows: CursorScenarioRow[]): Assertion[] {
    return [
      { label: "Assigned workspace is the effective target", passed: rows[0].action.enabled && rows[0].workspaceKind === "assigned-workspace" },
      { label: "Project root works without a separate workspace", passed: rows[1].action.enabled && rows[1].workspaceKind === "project-root" },
      { label: "Launch failures remain visible", passed: rows[2].action.enabled },
      { label: "Missing workspace is visibly unavailable", passed: !rows[3].action.enabled },
      { label: "Launch uses one argv value without a shell", passed: this.calls.every((call) => call.args.length === 1) },
    ];
  }
}

export type CursorActionVisual = {
  kind: "cursor-action";
  rows: CursorScenarioRow[];
  lastResult: string;
  calls: number;
};
type CursorScenarioRow = {
  id: string;
  title: string;
  root: string;
  workspaceKind: string;
  action: CursorActionState;
  actionHtml: string;
};
type ScenarioBlob = { id: string; title: string; cwd: string; executionWorkspaceRoot: string };
type CursorCall = { executable: string; args: string[] };
type Assertion = { label: string; passed: boolean };
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: [];
  blobs: [];
  receipts: [];
  assertions: Assertion[];
  evidenceCards: Array<{ label: string; value: string }>;
  visual: CursorActionVisual;
};
type Scenario = { id: string; frames: WorkbenchFrame[] };

const scenarioId = "cursor-action";

import type { CursorActionState } from "../../src/CursorAction.ts";
import { CursorLaunchError, CursorWorkspaceLauncher } from "../../src/CursorAction.ts";
import { cursorActionMarkup } from "../../src/CursorActionView.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
