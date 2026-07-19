test("no-argument home is content-first TOON", () => {
  const fixture = createCliFixture();
  const result = runCli(fixture, []);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^bin: /);
  assert.match(result.stdout, /description: Move blobs down Git-defined steps/);
  assert.match(result.stdout, /blobs: \[\]/);
});

test("root help exposes service installation and keeps workbench internal", () => {
  const fixture = createCliFixture();
  const result = runCli(fixture, ["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /service/);
  assert.doesNotMatch(result.stdout, /workbench/);
});

test("add is idempotent and supports repeated artifact refs in JSON", () => {
  const fixture = createCliFixture();
  const args = [
    "add", "blob-1", "Test blob",
    "--pipeline", fixture.pipelinePath,
    "--cwd", fixture.root,
    "--input-ref", "ticket:1",
    "--input-ref", "brief:1",
    "--db", fixture.databasePath,
    "--json",
  ];

  const first = JSON.parse(runCli(fixture, args).stdout);
  const second = JSON.parse(runCli(fixture, args).stdout);

  assert.equal(first.ok, "add blob-1 -> plan.define");
  assert.equal(first.already, false);
  assert.equal(second.already, true);
});

test("add defaults to the highest default pipeline version and records its identity", () => {
  const fixture = createCliFixture();
  const defaultRoot = join(fixture.root, "pipelines", "default");
  mkdirSync(defaultRoot, { recursive: true });
  renameSync(fixture.pipelinePath, join(defaultRoot, "v1"));
  mkdirSync(join(defaultRoot, "v2"));
  writeStep(join(defaultRoot, "v2"), 1, "g2.newest");

  const added = JSON.parse(runCli(fixture, ["add", "blob-2", "Latest", "--json"]).stdout);
  const shown = JSON.parse(runCli(fixture, ["show", "blob-2", "--json"]).stdout);

  assert.equal(added.ok, "add blob-2 -> g2.newest");
  assert.equal(shown.blob.pipeline, "default/v2");
  assert.equal(shown.blob.pipelinePath.endsWith("/pipelines/default/v2"), true);
  assert.equal(existsSync(join(fixture.root, "pipelines", "axi-factorio.db")), true);
});

test("unknown flags fail as structured usage errors", () => {
  const fixture = createCliFixture();
  const result = runCli(fixture, ["list", "--wat", "--db", fixture.databasePath]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /^error: unknown flag --wat\./);
  assert.equal(result.stderr.includes("command_failed"), true);
});

test("value flags reject another option as their value", () => {
  const fixture = createCliFixture();
  const result = runCli(fixture, ["list", "--db", "--json"]);

  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error, "--db requires a value.");
  assert.equal(existsSync(join(fixture.root, "--json")), false);
});

test("init reports whether the database already existed", () => {
  const fixture = createCliFixture();
  const args = ["init", "--db", fixture.databasePath, "--json"];

  assert.equal(JSON.parse(runCli(fixture, args).stdout).already, false);
  assert.equal(JSON.parse(runCli(fixture, args).stdout).already, true);
});

function createCliFixture(): CliFixture {
  const pipeline = createPipeline();
  return { ...pipeline, databasePath: join(pipeline.root, "factorio.sqlite") };
}

function runCli(fixture: CliFixture, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", cliPath, ...args],
    { cwd: fixture.root, encoding: "utf8" },
  );
}

type CliFixture = PipelineFixture & { databasePath: string };

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

import type { SpawnSyncReturns } from "node:child_process";
import type { PipelineFixture } from "./Fixtures.ts";
import { createPipeline, writeStep } from "./Fixtures.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
