export async function runCodexMcpIsolationScenario(): Promise<CodexMcpIsolationResult> {
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
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), fakeCodex);
  chmodSync(join(bin, "codex"), 0o755);
  return new ScenarioFixture(base, argvLog, `${bin}${delimiter}${process.env.PATH ?? ""}`);
}

class ScenarioFixture {
  private readonly base: TestHarness;
  private readonly argvLog: string;
  private readonly isolatedPath: string;
  private readonly originalPath = process.env.PATH ?? "";

  constructor(base: TestHarness, argvLog: string, isolatedPath: string) {
    this.base = base;
    this.argvLog = argvLog;
    this.isolatedPath = isolatedPath;
  }

  async run(): Promise<CodexMcpIsolationResult> {
    process.env.PATH = this.isolatedPath;
    process.env.FAKE_CODEX_ARGV = this.argvLog;
    this.createBlob();
    await this.runSafely();
    const receipt = this.base.store.listReceipts(blobId).at(-1)!;
    const argv = existsSync(this.argvLog) ? readFileSync(this.argvLog, "utf8") : "";
    return {
      id: scenarioId,
      frames: [this.frame(receipt, argv)],
      observedReceipt: receipt,
      argv,
    };
  }

  dispose(): void {
    process.env.PATH = this.originalPath;
    delete process.env.FAKE_CODEX_ARGV;
    this.base.dispose();
  }

  private createBlob(): void {
    this.base.store.createBlob(blobId, {
      title: "Unrelated MCP isolation",
      body: "Execute without loading app-specific MCP servers.",
      cwd: dirname(this.base.pipelinePath),
      pipelinePath: this.base.pipelinePath,
      inputArtifacts: [],
    });
    this.base.store.requestStep(blobId);
  }

  private async runSafely(): Promise<void> {
    const runner = new ConveyorRunner(this.base.store, new CodexHarness());
    try {
      await runner.runOnce();
    } catch (error) {
      if (!(error instanceof ReceiptRunError)) throw error;
    }
  }

  private frame(receipt: Receipt, argv: string): WorkbenchFrame {
    const isolated = argv.match(/^--ignore-user-config$/gmu)?.length === 2;
    const entrySafe = /\n--\n---\naxi-factorio runtime context\n/u.test(argv);
    const resumeSafe = /\nresume\nthread-mcp-isolated\n--\n---\naxi-factorio runtime context\n/u.test(argv);
    return {
      name: "Pinned Codex 0.144.6 MCP isolation",
      description: `Expected advance; observed ${receipt.status}. Exact pinned-CLI argv + production receipt path.`,
      source: "scenario",
      steps: [{ id: "g1.first", label: "First" }],
      blobs: [{
        id: blobId,
        title: "Unrelated MCP isolation",
        state: receipt.status === "advance" ? "complete" : "failed",
        stepId: receipt.status === "advance" ? "complete" : "g1.first",
      }],
      receipts: [viewReceipt(receipt)],
      assertions: [
        { label: "Codex invocation ignores unrelated user MCP configuration", passed: isolated },
        { label: "Fresh prompt follows the 0.144.6 option terminator", passed: entrySafe },
        { label: "Resumed prompt follows the 0.144.6 resume contract", passed: resumeSafe },
        { label: "Irrelevant AbletonMCP failure cannot block the stage", passed: receipt.status === "advance" },
        { label: "Production receipt advances normally", passed: receipt.status === "advance" },
      ],
    };
  }
}

function viewReceipt(receipt: Receipt): WorkbenchReceipt {
  return {
    id: receipt.id,
    blobId: receipt.blobId,
    stepId: receipt.stepId,
    status: receipt.status,
    at: (receipt.finishedAt ?? receipt.startedAt).slice(11, 19),
    detail: receipt.error ?? receipt.reason ?? `attempt ${receipt.attempt}`,
  };
}

const fakeCodex = `#!/bin/sh
isolated=0
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$FAKE_CODEX_ARGV"
  [ "$arg" = "--ignore-user-config" ] && isolated=1
done
printf '\\n' >> "$FAKE_CODEX_ARGV"
if [ "$isolated" -ne 1 ]; then
  printf '%s\\n' 'ERROR MCP client for AbletonMCP failed to start: timed out handshaking' >&2
  exit 1
fi
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-mcp-isolated"}'
case " $* " in
  *" resume "*)
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"decision\\":\\"advance\\",\\"reason\\":\\"isolated\\",\\"outputArtifacts\\":[\\"proof:mcp-isolated\\"]}"}}'
    ;;
  *)
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"entry complete"}}'
    ;;
esac
`;
const scenarioId = "codex-mcp-isolation";
const blobId = "codex-mcp-isolation";

export type CodexMcpIsolationResult = {
  id: string;
  frames: WorkbenchFrame[];
  observedReceipt: Receipt;
  argv: string;
};
type WorkbenchFrame = {
  name: string;
  description: string;
  source: "scenario";
  steps: Array<{ id: string; label: string }>;
  blobs: Array<{ id: string; title: string; state: string; stepId: string }>;
  receipts: WorkbenchReceipt[];
  assertions: Array<{ label: string; passed: boolean }>;
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
