export async function runCodexWritableContinuationScenario(): Promise<CodexWritableContinuationResult> {
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
  const bin = join(root, "bin");
  const argvLog = join(root, "codex-argv.log");
  const artifactPath = join(root, "fixture-artifact.txt");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), fakeCodex);
  chmodSync(join(bin, "codex"), 0o755);
  return new ScenarioFixture(base, argvLog, artifactPath, `${bin}${delimiter}${process.env.PATH ?? ""}`);
}

class ScenarioFixture {
  private readonly base: TestHarness;
  private readonly argvLog: string;
  private readonly artifactPath: string;
  private readonly isolatedPath: string;
  private readonly originalPath = process.env.PATH ?? "";

  constructor(
    base: TestHarness,
    argvLog: string,
    artifactPath: string,
    isolatedPath: string,
  ) {
    this.base = base;
    this.argvLog = argvLog;
    this.artifactPath = artifactPath;
    this.isolatedPath = isolatedPath;
  }

  async run(): Promise<CodexWritableContinuationResult> {
    this.prepare();
    await this.runStep();
    const first = this.capture("After entry + retry");
    this.base.store.requestStep(blobId);
    await this.runStep();
    const second = this.capture("After same-task continuation");
    return this.result(first, second);
  }

  dispose(): void {
    process.env.PATH = this.originalPath;
    delete process.env.FAKE_CODEX_ARGV;
    delete process.env.FAKE_CODEX_ARTIFACT;
    this.base.dispose();
  }

  private prepare(): void {
    process.env.PATH = this.isolatedPath;
    process.env.FAKE_CODEX_ARGV = this.argvLog;
    process.env.FAKE_CODEX_ARTIFACT = this.artifactPath;
    this.base.store.createBlob(blobId, {
      title: "Writable same-step continuation",
      body: "Write and then improve the durable fixture artifact.",
      cwd: dirname(this.base.pipelinePath),
      pipelinePath: this.base.pipelinePath,
      inputArtifacts: [],
    });
    this.base.store.requestStep(blobId);
  }

  private async runStep(): Promise<void> {
    const runner = new ConveyorRunner(this.base.store, new CodexHarness());
    try {
      await runner.runOnce();
    } catch (error) {
      if (!(error instanceof ReceiptRunError)) throw error;
    }
  }

  private capture(label: string): ScenarioCapture {
    return {
      label,
      artifact: existsSync(this.artifactPath) ? readFileSync(this.artifactPath, "utf8") : "(missing)",
      receipts: this.base.store.listReceipts(blobId),
      argv: existsSync(this.argvLog) ? readFileSync(this.argvLog, "utf8") : "",
    };
  }

  private result(first: ScenarioCapture, second: ScenarioCapture): CodexWritableContinuationResult {
    const externalRuns = new Set(second.receipts.map((receipt) => receipt.externalRunId));
    return {
      id: scenarioId,
      frames: [frame(first, 1), frame(second, 2)],
      receipts: second.receipts,
      artifact: second.artifact,
      argv: second.argv,
      externalRunIds: [...externalRuns],
    };
  }
}

function frame(capture: ScenarioCapture, attempt: number): WorkbenchFrame {
  const final = capture.receipts.at(-1);
  const argvCalls = parseArgv(capture.argv);
  const expected = attempt === 1 ? firstArtifact : improvedArtifact;
  return {
    name: "Writable Codex continuation",
    description: `Expected ${expected}; observed ${capture.artifact}. Real Store → Runner → CodexHarness receipts.`,
    source: "scenario",
    steps: [{ id: "g1.first", label: "First" }],
    blobs: [{
      id: blobId,
      title: "Writable same-step continuation",
      state: final?.status === "advance" ? "complete" : "waiting",
      stepId: final?.status === "advance" ? "complete" : "g1.first",
    }],
    receipts: capture.receipts.map(viewReceipt),
    assertions: assertions(capture, argvCalls, attempt),
    evidenceCards: evidenceCards(capture, argvCalls, expected),
  };
}

function assertions(capture: ScenarioCapture, calls: string[][], attempt: number): WorkbenchAssertion[] {
  const expectedStatus = attempt === 1 ? "retry" : "advance";
  const relevantCalls = attempt === 1 ? calls.slice(0, 2) : calls.slice(2, 4);
  return [
    { label: `Attempt ${attempt} receipt is ${expectedStatus}`, passed: capture.receipts.at(-1)?.status === expectedStatus },
    { label: `Attempt ${attempt} artifact matches expected content`, passed: capture.artifact === (attempt === 1 ? firstArtifact : improvedArtifact) },
    { label: "Entry, continuation, and exit use workspace-write", passed: relevantCalls.every(hasWorkspaceWrite) },
    { label: "Same external Codex task is reused", passed: new Set(capture.receipts.map((receipt) => receipt.externalRunId)).size === 1 },
  ];
}

function evidenceCards(
  capture: ScenarioCapture,
  calls: string[][],
  expected: string,
): WorkbenchEvidenceCard[] {
  return [
    { label: "Expected artifact", value: expected },
    { label: "Observed artifact", value: capture.artifact },
    { label: "Receipt states", value: capture.receipts.map((receipt) => `#${receipt.attempt} ${receipt.status}`).join("\n") },
    { label: "Final decision", value: capture.receipts.at(-1)?.status ?? "missing" },
    { label: "Entry argv", value: formatArgv(calls[0]) },
    { label: "Continuation argv", value: formatArgv(calls[2]) },
    { label: "Exit argv", value: formatArgv(calls.at(-1)) },
  ];
}

function parseArgv(log: string): string[][] {
  return log.trim().split("\n\n").filter(Boolean).map((call) => call.split("\n"));
}

function hasWorkspaceWrite(args: string[]): boolean {
  const sandbox = args.indexOf("--sandbox");
  return sandbox >= 0 && args[sandbox + 1] === "workspace-write";
}

function formatArgv(args: string[] | undefined): string {
  return args?.join(" ") ?? "(not invoked)";
}

function viewReceipt(receipt: Receipt): WorkbenchReceipt {
  return {
    id: receipt.id,
    blobId: receipt.blobId,
    stepId: receipt.stepId,
    status: receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.reason ?? receipt.error ?? `attempt ${receipt.attempt}`,
  };
}

const scenarioId = "codex-writable-continuation";
const blobId = "codex-writable-continuation";
const firstArtifact = "fixture:first";
const improvedArtifact = "fixture:improved";
const fakeCodex = `#!/bin/sh
sandbox=0
last=""
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$FAKE_CODEX_ARGV"
  [ "$arg" = "workspace-write" ] && sandbox=1
  last="$arg"
done
printf '\\n' >> "$FAKE_CODEX_ARGV"
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-writable-fixture"}'
case "$last" in
  *'"phase": "continuation"'*)
    [ "$sandbox" -eq 1 ] && printf '%s' '${improvedArtifact}' > "$FAKE_CODEX_ARTIFACT"
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"continuation complete"}}'
    ;;
  *"Evaluate blob"*)
    if [ "$(cat "$FAKE_CODEX_ARTIFACT" 2>/dev/null)" = "${improvedArtifact}" ]; then
      decision=advance
    else
      decision=retry
    fi
    printf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"{\\\\\\"decision\\\\\\":\\\\\\"$decision\\\\\\",\\\\\\"reason\\\\\\":\\\\\\"artifact $decision\\\\\\",\\\\\\"outputArtifacts\\\\\\":[\\\\\\"file:$FAKE_CODEX_ARTIFACT\\\\\\"]}\\"}}"
    ;;
  *)
    [ "$sandbox" -eq 1 ] && printf '%s' '${firstArtifact}' > "$FAKE_CODEX_ARTIFACT"
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"entry complete"}}'
    ;;
esac
`;

export type CodexWritableContinuationResult = {
  id: string;
  frames: WorkbenchFrame[];
  receipts: Receipt[];
  artifact: string;
  argv: string;
  externalRunIds: Array<string | null>;
};
type ScenarioCapture = { label: string; artifact: string; receipts: Receipt[]; argv: string };
type WorkbenchAssertion = { label: string; passed: boolean };
type WorkbenchEvidenceCard = { label: string; value: string };
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: WorkbenchReceipt[];
  assertions: WorkbenchAssertion[];
  evidenceCards: WorkbenchEvidenceCard[];
};
type WorkbenchReceipt = {
  id: string;
  blobId: string;
  stepId: string;
  status: string;
  at: string;
  detail: string;
};

import type { Receipt } from "../../src/Types.ts";
import type { TestHarness } from "./CreateTestHarness.ts";
import { CodexHarness } from "../../src/CodexHarness.ts";
import { ConveyorRunner, ReceiptRunError } from "../../src/Runner.ts";
import { createTestHarness } from "./CreateTestHarness.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
