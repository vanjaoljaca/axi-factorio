test("the bundled AXI skill is generated from the CLI guidance", () => {
  const path = join(import.meta.dirname, "..", "skills", "axi-factorio", "SKILL.md");
  assert.equal(readFileSync(path, "utf8"), axiFactorioSkill());
  assert.match(axiFactorioSkill(), /Run `axi-factorio` first/u);
});

test("the official AXI SDK is pinned for session-hook integration", () => {
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(packageJson.dependencies["axi-sdk-js"], "0.1.8");
});

test("AXI setup installs directory-scoped session hooks for the three default agents", () => {
  const home = mkdtempSync(join(tmpdir(), "axi-factorio-axi-home-"));
  const entry = join(home, "node_modules", "axi-factorio", "dist", "src", "cli.js");
  try {
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "#!/usr/bin/env node\n");
    const result = installAxiFactorioHooks({ homeDir: home, execPath: entry, shouldInstall: () => true });

    assert.deepEqual(result.agents, ["Claude Code", "Codex", "OpenCode"]);
    assert.match(readFileSync(join(home, ".claude", "settings.json"), "utf8"), /axi-factorio/u);
    assert.match(readFileSync(join(home, ".codex", "hooks.json"), "utf8"), /axi-factorio/u);
    assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /hooks = true/u);
    assert.match(readFileSync(join(home, ".config", "opencode", "plugins", "axi-axi-factorio.js"), "utf8"), /axi-factorio/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

import { axiFactorioSkill } from "../src/AxiGuidance.ts";
import { installAxiFactorioHooks } from "../src/AxiSetup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
