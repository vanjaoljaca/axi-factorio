export function installAxiFactorioHooks(options: HookSetupOptions = {}): HookSetupResult {
  const errors: string[] = [];
  installSessionStartHooks({
    marker: "axi-factorio",
    binaryNames: ["axi-factorio"],
    distEntrypoints: ["dist/src/cli.js"],
    homeDir: options.homeDir,
    execPath: options.execPath,
    shouldInstall: options.shouldInstall,
    onError: (message) => errors.push(message),
  });
  if (errors.length) throw new Error(`AXI hook setup failed: ${errors.join("; ")}`);
  return {
    setup: "session hooks installed or already up to date",
    agents: ["Claude Code", "Codex", "OpenCode"],
    context: "directory-scoped axi-factorio home view",
  };
}

type HookSetupResult = { setup: string; agents: string[]; context: string };
type HookSetupOptions = {
  homeDir?: string;
  execPath?: string;
  shouldInstall?: (execPath: string) => boolean;
};

import { installSessionStartHooks } from "axi-sdk-js";
