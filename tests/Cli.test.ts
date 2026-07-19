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

test("every public command exposes concise help without opening runtime state", () => {
  const fixture = createCliFixture();
  const commands = [
    "project", "add", "list", "status", "show", "receipts", "retry", "rewind",
    "kick", "run", "evaluate", "service", "init",
  ];
  for (const command of commands) {
    const result = runCli(fixture, [command, "--help"]);
    assert.equal(result.status, 0, command);
    assert.match(result.stdout, /^Usage: axi-factorio /, command);
  }
});

test("projects own default pipeline selectors and blobs attach to projects", () => {
  const fixture = createCliFixture();
  const defaultRoot = join(fixture.root, "pipelines", "default");
  const appRoot = join(fixture.root, "apps", "app");
  mkdirSync(defaultRoot, { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  renameSync(fixture.pipelinePath, join(defaultRoot, "v1"));

  const project = JSON.parse(runCli(fixture, [
    "project", "add", "app", "App",
    "--root", appRoot,
    "--pipeline-root", join(fixture.root, "pipelines"),
    "--json",
  ]).stdout);
  const updated = JSON.parse(runCli(fixture, [
    "project", "upsert", "app", "Renamed App",
    "--root", appRoot,
    "--pipeline-root", join(fixture.root, "pipelines"),
    "--json",
  ]).stdout);
  const blob = JSON.parse(runCli(fixture, [
    "add", "blob-project", "Project blob", "--project", "app", "--json",
  ]).stdout);
  const shown = JSON.parse(runCli(fixture, ["show", "blob-project", "--json"]).stdout);

  assert.equal(project.project.defaultPipeline, "default");
  assert.equal(project.project.root, appRoot);
  assert.equal(project.project.pipelineRoot, join(fixture.root, "pipelines"));
  assert.equal(project.project.resolvedPipeline, "default/v1");
  assert.equal(updated.project.name, "Renamed App");
  assert.equal(updated.already, false);
  assert.equal(blob.blob.project, "app");
  assert.equal(shown.blob.cwd, appRoot);
  assert.equal(shown.blob.pipeline, "default/v1");
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

test("human feedback and approval append evidence to the current step", () => {
  const fixture = createCliFixture();
  runCli(fixture, [
    "add", "blob-review", "Review me", "--pipeline", fixture.pipelinePath,
    "--cwd", fixture.root, "--json",
  ]);

  const review = JSON.parse(runCli(fixture, [
    "review", "blob-review", "--note", "Await Workbench", "--json",
  ]).stdout);
  const feedback = JSON.parse(runCli(fixture, [
    "feedback", "blob-review", "Use less chrome", "--evidence", "voice-note:1", "--json",
  ]).stdout);
  const approval = JSON.parse(runCli(fixture, [
    "approve", "blob-review", "--note", "Approved", "--evidence", "git-head:abc", "--json",
  ]).stdout);
  const shown = JSON.parse(runCli(fixture, ["show", "blob-review", "--json"]).stdout);

  assert.equal(review.humanInput.kind, "review");
  assert.deepEqual(feedback.humanInput.evidence, ["voice-note:1"]);
  assert.equal(approval.humanInput.kind, "approval");
  assert.equal(shown.blob.humanGateApproved, true);
  assert.deepEqual(shown.humanInputs.map((input: { kind: string }) => input.kind), [
    "review", "feedback", "approval",
  ]);
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
