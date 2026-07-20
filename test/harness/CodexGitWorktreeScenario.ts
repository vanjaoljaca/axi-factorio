export async function runCodexGitWorktreeScenario(): Promise<CodexGitWorktreeResult> {
  const fixture = createFixture();
  try {
    return await fixture.run();
  } finally {
    fixture.dispose();
  }
}

function createFixture(): ScenarioFixture {
  const base = createTestHarness();
  const root = dirname(base.pipelinePath);
  const repository = join(root, "repository");
  const worktree = join(root, "linked-worktree");
  const outside = join(root, "outside");
  const bin = join(root, "bin");
  for (const path of [repository, outside, bin]) mkdirSync(path, { recursive: true });
  initializeRepository(repository, worktree);
  const app = join(worktree, "apps", "example");
  const sibling = join(worktree, "apps", "example-workbench");
  const git = gitPaths(worktree);
  writeFileSync(join(bin, "codex"), fakeCodex);
  chmodSync(join(bin, "codex"), 0o755);
  return new ScenarioFixture(base, {
    root, repository, worktree: realpathSync(worktree), app: realpathSync(app),
    sibling: realpathSync(sibling), outside: realpathSync(outside), bin, ...git,
    argvLog: join(root, "codex-argv.log"),
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

  async run(): Promise<CodexGitWorktreeResult> {
    this.prepare();
    const beforeHead = head(this.paths.worktree);
    process.env.FAKE_BEFORE_HEAD = beforeHead;
    await this.runStep();
    return this.result(beforeHead);
  }

  dispose(): void {
    process.env.PATH = this.originalPath;
    for (const key of scenarioEnvironment) delete process.env[key];
    this.base.dispose();
  }

  private prepare(): void {
    applyScenarioEnvironment(this.paths, this.originalPath);
    this.base.store.createProject(projectId, {
      name: "Example app", root: this.paths.app,
      pipelineRoot: dirname(this.base.pipelinePath), defaultPipeline: this.base.pipelinePath,
    });
    this.base.store.createBlob(blobId, {
      title: "Commit app and Workbench together",
      body: "Edit both fixtures and commit the exact linked-worktree head.",
      cwd: this.paths.app, executionWorkspaceRoot: this.paths.worktree, projectId,
      pipelineId: "default/v1", pipelinePath: this.base.pipelinePath, inputArtifacts: [],
    });
  }

  private async runStep(): Promise<void> {
    this.base.store.requestStep(blobId);
    try {
      await new ConveyorRunner(this.base.store, new CodexHarness()).runOnce();
    } catch (error) {
      if (!(error instanceof ReceiptRunError)) throw error;
    }
  }

  private result(beforeHead: string): CodexGitWorktreeResult {
    const receipts = this.base.store.listReceipts(blobId);
    const argv = existsSync(this.paths.argvLog) ? readFileSync(this.paths.argvLog, "utf8") : "";
    const afterHead = head(this.paths.worktree);
    const files = observedFiles(this.paths);
    const writableDirs = [...new Set(parseArgv(argv).flatMap(additionalWritableDirs))];
    const frame = workbenchFrame(this.paths, receipts, beforeHead, afterHead, argv, writableDirs, files);
    return { id: scenarioId, frames: [frame], receipts, beforeHead, afterHead, argv, writableDirs, files };
  }
}

function initializeRepository(repository: string, worktree: string): void {
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Factorio Scenario"]);
  git(repository, ["config", "user.email", "scenario@axi-factorio.local"]);
  mkdirSync(join(repository, "apps", "example"), { recursive: true });
  mkdirSync(join(repository, "apps", "example-workbench"), { recursive: true });
  writeFileSync(join(repository, "apps", "example", "app.txt"), "app:before\n");
  writeFileSync(join(repository, "apps", "example-workbench", "fixture.txt"), "workbench:before\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "initial fixture"]);
  git(repository, ["worktree", "add", "-b", "scenario-change", worktree]);
}

function gitPaths(worktree: string): GitPaths {
  const output = git(worktree, [
    "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir",
    "--git-path", "objects", "--git-path", "refs", "--git-path", "logs",
  ]).trim().split("\n");
  return {
    gitDir: realpathSync(output[1]!),
    gitCommonDir: realpathSync(output[2]!),
    gitObjects: realpathSync(output[3]!),
    gitRefs: realpathSync(output[4]!),
    gitLogs: realpathSync(output[5]!),
  };
}

function applyScenarioEnvironment(paths: ScenarioPaths, originalPath: string): void {
  process.env.PATH = `${paths.bin}${delimiter}${originalPath}`;
  process.env.FAKE_CODEX_ARGV = paths.argvLog;
  process.env.FAKE_WORKTREE_ROOT = paths.worktree;
  process.env.FAKE_APP_ROOT = paths.app;
  process.env.FAKE_SIBLING_ROOT = paths.sibling;
  process.env.FAKE_OUTSIDE_ROOT = paths.outside;
  process.env.FAKE_GIT_DIR = paths.gitDir;
  process.env.FAKE_GIT_OBJECTS = paths.gitObjects;
  process.env.FAKE_GIT_REFS = paths.gitRefs;
  process.env.FAKE_GIT_LOGS = paths.gitLogs;
}

function workbenchFrame(
  paths: ScenarioPaths,
  receipts: Receipt[],
  beforeHead: string,
  afterHead: string,
  argv: string,
  writableDirs: string[],
  files: ObservedFiles,
): WorkbenchFrame {
  const receipt = receipts.at(-1);
  const advanced = receipt?.status === "advance";
  const required = [paths.gitDir, paths.gitObjects, paths.gitRefs, paths.gitLogs];
  return {
    name: "Commit safely from a linked Git worktree",
    description: "The worktree stays the sandbox; only Git-owned metadata required to commit is added.",
    source: "scenario",
    steps: [{ id: "g1.first", label: "Build + commit" }],
    blobs: [{
      id: blobId, title: "Commit app and Workbench together",
      state: advanced ? "complete" : "failed", stepId: advanced ? "complete" : "g1.first",
    }],
    receipts: receipts.map(viewReceipt),
    assertions: [
      { label: "Git reports the linked worktree and metadata roots", passed: paths.gitDir !== paths.gitCommonDir },
      { label: "Codex runs with the linked worktree as cwd", passed: parseArgv(argv).every((call) => cwd(call) === paths.worktree) },
      { label: "Only required Git metadata directories are additionally writable", passed: samePaths(writableDirs, required) },
      { label: "App and sibling Workbench fixtures changed", passed: files.app && files.sibling },
      { label: "Git head advanced in the linked worktree", passed: beforeHead !== afterHead },
      { label: "Exit observed the commit and advanced", passed: advanced },
      { label: "No write escaped the worktree or resolved Git metadata", passed: !files.outside },
    ],
    visual: {
      kind: "git-worktree", worktreeRoot: paths.worktree, projectRoot: paths.app,
      siblingRoot: paths.sibling, gitDir: paths.gitDir, gitCommonDir: paths.gitCommonDir,
      writableDirs, beforeHead, afterHead, decision: receipt?.status ?? "missing", files,
    },
    evidenceCards: [
      { label: "Exact Codex argv", value: parseArgv(argv).map(formatArgv).join("\n\n") },
      { label: "Resolved Git paths", value: JSON.stringify({
        worktree: paths.worktree, gitDir: paths.gitDir, gitCommonDir: paths.gitCommonDir,
        writableDirs,
      }, null, 2) },
    ],
  };
}

function observedFiles(paths: ScenarioPaths): ObservedFiles {
  return {
    app: readFileSync(join(paths.app, "app.txt"), "utf8").trim() === "app:after",
    sibling: readFileSync(join(paths.sibling, "fixture.txt"), "utf8").trim() === "workbench:after",
    outside: existsSync(join(paths.outside, "escaped.txt")),
  };
}

function additionalWritableDirs(args: string[]): string[] {
  return args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]!] : []);
}

function samePaths(actual: string[], expected: string[]): boolean {
  return [...new Set(actual)].sort().join("\n") === [...expected].sort().join("\n");
}

function parseArgv(log: string): string[][] {
  return log.trim().split("\n\n").filter(Boolean).map((call) => call.split("\n"));
}

function cwd(args: string[]): string | undefined {
  const index = args.indexOf("-C");
  return index >= 0 ? args[index + 1] : undefined;
}

function formatArgv(args: string[]): string {
  return args.join(" ");
}

function viewReceipt(receipt: Receipt): WorkbenchReceipt {
  return {
    id: receipt.id, blobId: receipt.blobId, stepId: receipt.stepId, status: receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.reason ?? receipt.error ?? `attempt ${receipt.attempt}`,
  };
}

function head(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

const scenarioId = "codex-git-worktree";
const projectId = "git-worktree-project";
const blobId = "git-worktree-blob";
const scenarioEnvironment = [
  "FAKE_CODEX_ARGV", "FAKE_WORKTREE_ROOT", "FAKE_APP_ROOT", "FAKE_SIBLING_ROOT",
  "FAKE_OUTSIDE_ROOT", "FAKE_GIT_DIR", "FAKE_GIT_OBJECTS", "FAKE_GIT_REFS", "FAKE_GIT_LOGS",
  "FAKE_BEFORE_HEAD",
];
const fakeCodex = `#!/bin/sh
last=""
cwd=""
previous=""
writable=""
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$FAKE_CODEX_ARGV"
  [ "$previous" = "-C" ] && cwd="$arg"
  [ "$previous" = "--add-dir" ] && writable="$writable
$arg"
  previous="$arg"
  last="$arg"
done
printf '\\n' >> "$FAKE_CODEX_ARGV"
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-git-worktree"}'
case "$last" in
  *"Evaluate blob"*)
    before="$FAKE_BEFORE_HEAD"
    after="$(git -C "$FAKE_WORKTREE_ROOT" rev-parse HEAD)"
    [ "$before" != "$after" ] && decision=advance || decision=retry
    printf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"{\\\\\\"decision\\\\\\":\\\\\\"$decision\\\\\\",\\\\\\"reason\\\\\\":\\\\\\"git worktree $decision\\\\\\",\\\\\\"outputArtifacts\\\\\\":[\\\\\\"git-head:$after\\\\\\"]}\\"}}"
    ;;
  *)
    required=1
    for path in "$FAKE_GIT_DIR" "$FAKE_GIT_OBJECTS" "$FAKE_GIT_REFS" "$FAKE_GIT_LOGS"; do
      printf '%s\\n' "$writable" | grep -Fqx "$path" || required=0
    done
    if [ "$cwd" = "$FAKE_WORKTREE_ROOT" ] && [ "$required" = 1 ]; then
      printf 'app:after\\n' > "$FAKE_APP_ROOT/app.txt"
      printf 'workbench:after\\n' > "$FAKE_SIBLING_ROOT/fixture.txt"
      git -C "$FAKE_WORKTREE_ROOT" add apps/example/app.txt apps/example-workbench/fixture.txt
      git -C "$FAKE_WORKTREE_ROOT" commit -m 'scenario change' >/dev/null
    fi
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"entry complete"}}'
    ;;
esac
`;

export type CodexGitWorktreeResult = {
  id: string;
  frames: WorkbenchFrame[];
  receipts: Receipt[];
  beforeHead: string;
  afterHead: string;
  argv: string;
  writableDirs: string[];
  files: ObservedFiles;
};
type GitPaths = {
  gitDir: string;
  gitCommonDir: string;
  gitObjects: string;
  gitRefs: string;
  gitLogs: string;
};
type ScenarioPaths = GitPaths & {
  root: string;
  repository: string;
  worktree: string;
  app: string;
  sibling: string;
  outside: string;
  bin: string;
  argvLog: string;
};
type ObservedFiles = { app: boolean; sibling: boolean; outside: boolean };
type WorkbenchReceipt = {
  id: string;
  blobId: string;
  stepId: string;
  status: string;
  at: string;
  detail: string;
};
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: WorkbenchReceipt[];
  assertions: Array<{ label: string; passed: boolean }>;
  evidenceCards: Array<{ label: string; value: string }>;
  visual: {
    kind: "git-worktree";
    worktreeRoot: string;
    projectRoot: string;
    siblingRoot: string;
    gitDir: string;
    gitCommonDir: string;
    writableDirs: string[];
    beforeHead: string;
    afterHead: string;
    decision: string;
    files: ObservedFiles;
  };
};

import type { Receipt } from "../../src/Types.ts";
import type { TestHarness } from "./CreateTestHarness.ts";
import { CodexHarness } from "../../src/CodexHarness.ts";
import { ConveyorRunner, ReceiptRunError } from "../../src/Runner.ts";
import { createTestHarness } from "./CreateTestHarness.ts";
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
