export type AxiPrincipleStatus = "pending" | "running" | "passed" | "failed";

export type AxiValidationVisual = {
  kind: "axi-validation";
  phase: "ready" | "running" | "passed" | "failed";
  principles: AxiPrincipleResult[];
};

export type AxiPrincipleResult = {
  index: number;
  name: string;
  test: string;
  status: AxiPrincipleStatus;
  durationMs: number | null;
};

export class AxiValidationScenario {
  play(): AxiValidationScenarioSnapshot {
    if (this.phase === "running") return this.snapshot();
    this.resetState("running");
    void this.validate().catch((error) => this.fail(error));
    return this.snapshot();
  }

  reset(): AxiValidationScenarioSnapshot {
    if (this.phase === "running") throw new Error("AXI validation is still running.");
    this.resetState("ready");
    return this.snapshot();
  }

  snapshot(): AxiValidationScenarioSnapshot {
    const passed = this.results.filter((item) => item.status === "passed").length;
    return {
      id: "axi-validation",
      frames: [{
        name: "AXI validation",
        description: "Ten published principles · actual CLI checks · no self-certified animation",
        source: "scenario",
        steps: [], blobs: [], receipts: [],
        assertions: [{ label: `${passed} of 10 principles pass`, passed: passed === 10 }],
        visual: { kind: "axi-validation", phase: this.phase, principles: this.results },
      }],
    };
  }

  private async validate(): Promise<void> {
    for (const result of this.results) await this.validatePrinciple(result);
    this.phase = this.results.every((item) => item.status === "passed") ? "passed" : "failed";
  }

  private async validatePrinciple(result: AxiPrincipleResult): Promise<void> {
    result.status = "running";
    const test = findTest(result.test);
    const run = await runVisualTest(test);
    result.durationMs = run.durationMs;
    result.status = run.passed ? "passed" : "failed";
    log("axi_validation_principle", result);
  }

  private resetState(phase: AxiValidationVisual["phase"]): void {
    this.phase = phase;
    this.results = principles.map((item) => ({ ...item, status: "pending", durationMs: null }));
  }

  private fail(error: unknown): void {
    this.phase = "failed";
    const running = this.results.find((item) => item.status === "running");
    if (running) running.status = "failed";
    log("axi_validation_failed", { error: error instanceof Error ? error.message : String(error) });
  }

  private phase: AxiValidationVisual["phase"] = "ready";
  private results: AxiPrincipleResult[] = [];

  constructor() {
    this.resetState("ready");
  }
}

function findTest(name: string): TestCatalogItem {
  const test = listVisualTests().find((item) => item.name === name);
  if (!test) throw new Error(`AXI validation test not found: ${name}`);
  return test;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

export type AxiValidationScenarioSnapshot = {
  id: string;
  frames: Array<{
    name: string;
    description: string;
    source: "scenario";
    steps: [];
    blobs: [];
    receipts: [];
    assertions: Array<{ label: string; passed: boolean }>;
    visual: AxiValidationVisual;
  }>;
};

const principles: Array<Omit<AxiPrincipleResult, "status" | "durationMs">> = [
  { index: 1, name: "Token-efficient output", test: "no-argument home is content-first TOON" },
  { index: 2, name: "Minimal default schemas", test: "AXI list defaults to four fields and supports explicit field selection" },
  { index: 3, name: "Content truncation", test: "AXI truncation includes the total size inline" },
  { index: 4, name: "Pre-computed aggregates", test: "no-argument home is content-first TOON" },
  { index: 5, name: "Definitive empty states", test: "no-argument home is content-first TOON" },
  { index: 6, name: "Structured errors & exit codes", test: "unknown flags fail as structured usage errors" },
  { index: 7, name: "Ambient context", test: "AXI setup installs directory-scoped session hooks for the three default agents" },
  { index: 8, name: "Content first", test: "AXI home discovers the parent database and scopes ambient state to the current directory" },
  { index: 9, name: "Contextual disclosure", test: "init reports whether the database already existed" },
  { index: 10, name: "Consistent help", test: "every public command exposes concise help without opening runtime state" },
];

import type { TestCatalogItem } from "../visual/TestCatalog.ts";
import { listVisualTests, runVisualTest } from "../visual/TestCatalog.ts";
