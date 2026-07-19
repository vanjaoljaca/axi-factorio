export type TestHarness = {
  pipelinePath: string;
  steps: StepDefinition[];
  database: FactorioDatabase;
  store: ConveyorStore;
  adapter: TestHarnessAdapter;
  runner: ConveyorRunner;
  dispose(): void;
};

export function createTestHarness(): TestHarness {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-harness-"));
  const database = new FactorioDatabase(join(root, "factorio.sqlite"));
  const store = new ConveyorStore(database);
  const adapter = new TestHarnessAdapter();
  return {
    pipelinePath, steps: discoverPipeline(pipelinePath), database, store, adapter,
    runner: new ConveyorRunner(store, adapter),
    dispose: () => dispose(database, root),
  };
}

export class TestHarnessAdapter implements ToolAdapter {
  readonly name = "test-harness";
  onExecute: (() => void) | null = null;

  async execute(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<AdapterResult> {
    this.onExecute?.();
    const externalRunId = `test-harness:${input.blob.id}:${input.step.id}`;
    onExternalRun(externalRunId);
    return {
      status: "advance", reason: "default harness advance",
      outputArtifacts: [], externalRunId,
    };
  }
}

function dispose(database: FactorioDatabase, root: string): void {
  database.close();
  rmSync(root, { recursive: true, force: true });
}

const pipelinePath = join(dirname(fileURLToPath(import.meta.url)), "default");

import type { ExternalRunHandler, ToolAdapter } from "../../src/Adapter.ts";
import type { AdapterInput, AdapterResult, StepDefinition } from "../../src/Types.ts";
import { FactorioDatabase } from "../../src/Database.ts";
import { ConveyorRunner } from "../../src/Runner.ts";
import { ConveyorStore } from "../../src/Store.ts";
import { discoverPipeline } from "../../src/Pipeline.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
