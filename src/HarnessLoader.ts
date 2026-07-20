export async function loadHarness(selector = defaultHarnessSelector()): Promise<AgentHarness> {
  if (selector === "codex") {
    const { CodexHarness } = await import("./CodexHarness.ts");
    return new CodexHarness();
  }
  const loaded = await loadExternal(selector, "createHarness", "harness");
  return assertAgentHarness(await instantiate(loaded));
}

export async function loadHarnessInstrumentation(
  selector = process.env.AXI_FACTORIO_INSTRUMENTATION ?? "none",
): Promise<HarnessInstrumentation> {
  if (selector === "none") return noHarnessInstrumentation;
  const loaded = await loadExternal(selector, "createInstrumentation", "instrumentation");
  return assertHarnessInstrumentation(await instantiate(loaded));
}

export function defaultHarnessSelector(): string {
  return process.env.AXI_FACTORIO_HARNESS ?? "codex";
}

async function loadExternal(
  selector: string,
  conventionalExport: string,
  kind: string,
): Promise<unknown> {
  if (!selector.startsWith("module:")) {
    throw new Error(`Unknown ${kind} selection ${selector}. Use module:SPECIFIER[#EXPORT].`);
  }
  const selection = selector.slice("module:".length);
  const hash = selection.lastIndexOf("#");
  const specifier = hash > 0 ? selection.slice(0, hash) : selection;
  const exportName = hash > 0 ? selection.slice(hash + 1) : conventionalExport;
  const module = await import(moduleUrl(specifier));
  const loaded = module[exportName] ?? module.default;
  if (!loaded) throw new Error(`${kind} module ${specifier} does not export ${exportName}.`);
  return loaded;
}

async function instantiate(value: unknown): Promise<unknown> {
  return typeof value === "function" ? value() : value;
}

function moduleUrl(specifier: string): string {
  if (specifier.startsWith("file:")) return specifier;
  const path = specifier.startsWith(".") || isAbsolute(specifier)
    ? resolve(process.cwd(), specifier)
    : createRequire(join(process.cwd(), "package.json")).resolve(specifier);
  return pathToFileURL(path).href;
}

import type { AgentHarness } from "./Harness.ts";
import type { HarnessInstrumentation } from "./HarnessInstrumentation.ts";
import { assertAgentHarness } from "./Harness.ts";
import {
  assertHarnessInstrumentation,
  noHarnessInstrumentation,
} from "./HarnessInstrumentation.ts";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
