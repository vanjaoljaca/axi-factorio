export async function runCodexExecutionWorkspaceScenario(): Promise<CodexExecutionWorkspaceResult> {
  const fixture = createFixture();
  try {
    return await fixture.run();
  } finally {
    fixture.dispose();
  }
}

function createFixture(): ScenarioFixture {
  const base = createTestHarness();
  const fixtureRoot = dirname(base.pipelinePath);
  const worktreeRoot = join(fixtureRoot, "worktree");
  const appRoot = join(worktreeRoot, "apps", "example");
  const siblingRoot = join(worktreeRoot, "apps", "example-workbench");
  const outsideRoot = join(fixtureRoot, "outside");
  const bin = join(fixtureRoot, "bin");
  for (const path of [appRoot, siblingRoot, outsideRoot, bin]) mkdirSync(path, { recursive: true });
  const planPath = join(appRoot, ".axi-factorio", "artifacts", blobId, "workbench-plan.md");
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, "Build the app and sibling Workbench fixture.");
  writeFileSync(join(bin, "codex"), fakeCodex);
  chmodSync(join(bin, "codex"), 0o755);
  return new ScenarioFixture(base, {
    fixtureRoot, worktreeRoot: realpathSync(worktreeRoot), appRoot: realpathSync(appRoot),
    siblingRoot: realpathSync(siblingRoot), outsideRoot: realpathSync(outsideRoot),
    planPath, bin, argvLog: join(fixtureRoot, "codex-argv.log"),
  });
}

class ScenarioFixture {
  private readonly base: TestHarness;
  private readonly paths: ScenarioPaths;
  private readonly originalPath = process.env.PATH ?? "";

  constructor(base: TestHarness, paths: ScenarioPaths) {
    this.base = base;
    this.paths = paths;
  }

  async run(): Promise<CodexExecutionWorkspaceResult> {
    this.prepare();
    const binding = this.bindThroughCli();
    await this.runStep();
    return this.result(binding);
  }

  dispose(): void {
    process.env.PATH = this.originalPath;
    for (const key of scenarioEnvironment) delete process.env[key];
    this.base.dispose();
  }

  private prepare(): void {
    process.env.PATH = `${this.paths.bin}${delimiter}${this.originalPath}`;
    process.env.FAKE_CODEX_ARGV = this.paths.argvLog;
    process.env.FAKE_PROJECT_ROOT = this.paths.appRoot;
    process.env.FAKE_EXECUTION_ROOT = this.paths.worktreeRoot;
    process.env.FAKE_SIBLING_ROOT = this.paths.siblingRoot;
    process.env.FAKE_OUTSIDE_ROOT = this.paths.outsideRoot;
    this.base.store.createProject(projectId, {
      name: "Example app", root: this.paths.appRoot,
      pipelineRoot: dirname(this.base.pipelinePath), defaultPipeline: this.base.pipelinePath,
    });
    this.base.store.createBlob(blobId, {
      title: "Build app and sibling Workbench",
      body: "Keep app-relative artifacts while executing from the containing worktree.",
      cwd: this.paths.appRoot, projectId, pipelineId: "default/v1",
      pipelinePath: this.base.pipelinePath, inputArtifacts: [`file:${this.paths.planPath}`],
    });
  }

  private bindThroughCli(): CliResult {
    return spawnSync(process.execPath, [
      "--disable-warning=ExperimentalWarning", cliPath,
      "--db", databasePath(this.base), "bind-execution", blobId,
      "--root", this.paths.worktreeRoot, "--evidence", "scenario:worktree-root", "--json",
    ], { encoding: "utf8" });
  }

  private async runStep(): Promise<void> {
    this.base.store.requestStep(blobId);
    const runner = new ConveyorRunner(this.base.store, new CodexHarness());
    try {
      await runner.runOnce();
    } catch (error) {
      if (!(error instanceof ReceiptRunError)) throw error;
    }
  }

  private result(binding: CliResult): CodexExecutionWorkspaceResult {
    const blob = this.base.store.getBlob(blobId)! as Blob & { executionWorkspaceRoot?: string };
    const receipts = this.base.store.listReceipts(blobId);
    const argv = existsSync(this.paths.argvLog) ? readFileSync(this.paths.argvLog, "utf8") : "";
    const files = observedFiles(this.paths);
    const bindings = executionBindings(this.base.store, blobId);
    return {
      id: scenarioId,
      frames: [frame(this.paths, blob, receipts, binding, argv, files, bindings)],
      projectRoot: blob.cwd,
      executionWorkspaceRoot: blob.executionWorkspaceRoot,
      receipts,
      argv,
      files,
      bindings,
      cliStatus: binding.status,
    };
  }
}

function frame(
  paths: ScenarioPaths,
  blob: Blob & { executionWorkspaceRoot?: string },
  receipts: Receipt[],
  binding: CliResult,
  argv: string,
  files: ObservedFiles,
  bindings: ExecutionBinding[],
): WorkbenchFrame {
  const receipt = receipts.at(-1);
  const calls = parseArgv(argv);
  const complete = receipt?.status === "advance";
  return {
    name: "App root inside an execution workspace",
    description: "Project identity stays apps/example while Codex executes within the containing worktree.",
    source: "scenario",
    steps: [{ id: "g1.first", label: "Build" }],
    blobs: [{
      id: blobId, title: "Build app and sibling Workbench",
      state: complete ? "complete" : "failed", stepId: complete ? "complete" : "g1.first",
    }],
    receipts: receipts.map(viewReceipt),
    assertions: [
      { label: "Explicit execution-workspace binding succeeds", passed: binding.status === 0 },
      { label: "Project root remains the app subdirectory", passed: blob.cwd === paths.appRoot },
      { label: "Codex cwd and sandbox root are the worktree", passed: calls.every((call) => cwd(call) === paths.worktreeRoot) },
      { label: "Entry reads app plan and edits app plus sibling Workbench", passed: files.plan && files.app && files.sibling },
      { label: "Exit observes both writes and advances", passed: complete },
      { label: "No write escapes the execution workspace", passed: !files.outside },
      { label: "Prompt names project and execution roots", passed: promptsNameRoots(argv, paths) },
      { label: "Binding provenance is append only", passed: bindings.length === 1 },
    ],
    evidenceCards: [
      { label: "Project root / app root", value: paths.appRoot },
      { label: "Binding CLI", value: `axi-factorio bind-execution ${blobId} --root ${paths.worktreeRoot} --evidence scenario:worktree-root\nexit ${binding.status}` },
      { label: "Execution workspace root", value: blob.executionWorkspaceRoot ?? "(not bound)" },
      { label: "Entry argv / cwd", value: formatArgv(calls[0]) },
      { label: "Exit argv / cwd", value: formatArgv(calls[1]) },
      { label: "Observed files", value: JSON.stringify(files, null, 2) },
      { label: "Receipt decision", value: receipt?.status ?? "missing" },
      { label: "Durable provenance", value: bindings.length ? JSON.stringify(bindings[0], null, 2) : "(missing)" },
    ],
  };
}

function observedFiles(paths: ScenarioPaths): ObservedFiles {
  return {
    plan: existsSync(paths.planPath),
    app: existsSync(join(paths.appRoot, "app-change.txt")),
    sibling: existsSync(join(paths.siblingRoot, "fixture-change.txt")),
    outside: existsSync(join(paths.outsideRoot, "escaped.txt")),
  };
}

function executionBindings(store: ConveyorStore, id: string): ExecutionBinding[] {
  const candidate = store as ConveyorStore & {
    listExecutionWorkspaceBindings?: (blobId: string) => ExecutionBinding[];
  };
  return candidate.listExecutionWorkspaceBindings?.(id) ?? [];
}

function parseArgv(log: string): string[][] {
  return log.trim().split("\n\n").filter(Boolean).map((call) => call.split("\n"));
}

function cwd(args: string[]): string | undefined {
  const index = args.indexOf("-C");
  return index >= 0 ? args[index + 1] : undefined;
}

function promptsNameRoots(argv: string, paths: ScenarioPaths): boolean {
  return occurrences(argv, paths.appRoot) >= 2 && occurrences(argv, paths.worktreeRoot) >= 2;
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function formatArgv(args: string[] | undefined): string {
  return args?.join(" ") ?? "(not invoked)";
}

function viewReceipt(receipt: Receipt): WorkbenchReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId, status: receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.reason ?? receipt.error ?? `attempt ${receipt.attempt}`,
  };
}

function databasePath(base: TestHarness): string {
  const row = base.database.connection.prepare("PRAGMA database_list").get() as { file: string };
  return row.file;
}

const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const scenarioId = "codex-execution-workspace";
const projectId = "execution-workspace-project";
const blobId = "execution-workspace-blob";
const scenarioEnvironment = [
  "FAKE_CODEX_ARGV", "FAKE_PROJECT_ROOT", "FAKE_EXECUTION_ROOT",
  "FAKE_SIBLING_ROOT", "FAKE_OUTSIDE_ROOT",
];
const fakeCodex = `#!/bin/sh
last=""
cwd=""
previous=""
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$FAKE_CODEX_ARGV"
  [ "$previous" = "-C" ] && cwd="$arg"
  previous="$arg"
  last="$arg"
done
printf '\\n' >> "$FAKE_CODEX_ARGV"
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-execution-workspace"}'
case "$last" in
  *"Evaluate blob"*)
    if [ -f "$FAKE_PROJECT_ROOT/app-change.txt" ] && [ -f "$FAKE_SIBLING_ROOT/fixture-change.txt" ]; then
      decision=advance
    else
      decision=retry
    fi
    printf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"{\\\\\\"decision\\\\\\":\\\\\\"$decision\\\\\\",\\\\\\"reason\\\\\\":\\\\\\"workspace $decision\\\\\\",\\\\\\"outputArtifacts\\\\\\":[\\\\\\"file:$FAKE_PROJECT_ROOT/app-change.txt\\\\\\",\\\\\\"file:$FAKE_SIBLING_ROOT/fixture-change.txt\\\\\\"]}\\"}}"
    ;;
  *)
    if [ "$cwd" = "$FAKE_EXECUTION_ROOT" ] && [ -f "$FAKE_PROJECT_ROOT/.axi-factorio/artifacts/execution-workspace-blob/workbench-plan.md" ]; then
      printf '%s' 'app:changed' > "$FAKE_PROJECT_ROOT/app-change.txt"
      printf '%s' 'workbench:changed' > "$FAKE_SIBLING_ROOT/fixture-change.txt"
    else
      printf '%s' 'unsafe-root' > "$FAKE_OUTSIDE_ROOT/escaped.txt"
    fi
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"entry complete"}}'
    ;;
esac
`;

export type CodexExecutionWorkspaceResult = {
  id: string;
  frames: WorkbenchFrame[];
  projectRoot: string;
  executionWorkspaceRoot?: string;
  receipts: Receipt[];
  argv: string;
  files: ObservedFiles;
  bindings: ExecutionBinding[];
  cliStatus: number | null;
};
type ScenarioPaths = {
  fixtureRoot: string;
  worktreeRoot: string;
  appRoot: string;
  siblingRoot: string;
  outsideRoot: string;
  planPath: string;
  bin: string;
  argvLog: string;
};
type ObservedFiles = { plan: boolean; app: boolean; sibling: boolean; outside: boolean };
type ExecutionBinding = {
  blobId: string;
  projectRoot: string;
  oldExecutionWorkspaceRoot: string;
  newExecutionWorkspaceRoot: string;
  evidence: string[];
};
type CliResult = ReturnType<typeof spawnSync>;
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: WorkbenchReceipt[];
  assertions: Array<{ label: string; passed: boolean }>;
  evidenceCards: Array<{ label: string; value: string }>;
};
type WorkbenchReceipt = {
  id: string;
  blobId: string;
  stepId: string;
  status: string;
  at: string;
  detail: string;
};

import type { Blob, Receipt } from "../../src/Types.ts";
import type { TestHarness } from "./CreateTestHarness.ts";
import { CodexHarness } from "../../src/CodexHarness.ts";
import { ConveyorRunner, ReceiptRunError } from "../../src/Runner.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { createTestHarness } from "./CreateTestHarness.ts";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
