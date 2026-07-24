test("no-argument home is content-first TOON", () => {
  const fixture = createCliFixture();
  const result = runCli(fixture, []);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^bin: /);
  assert.match(result.stdout, /description: Move blobs down Git-defined pipeline steps/);
  assert.match(result.stdout, /blobs: \[\]/);
  assert.match(result.stdout, /count: 0 of 0 total/);
});

test("AXI list defaults to four fields and supports explicit field selection", () => {
  const fixture = createCliFixture();
  runCli(fixture, ["add", "field-blob", "Field blob", "--pipeline", fixture.pipelinePath, "--json"]);

  const compact = JSON.parse(runCli(fixture, ["list", "--json"]).stdout);
  const selected = JSON.parse(runCli(fixture, [
    "list", "--fields", "id,state,executionMode,updatedAt", "--json",
  ]).stdout);
  const invalid = runCli(fixture, ["list", "--fields", "id,imaginary", "--json"]);

  assert.deepEqual(Object.keys(compact.blobs[0]), ["id", "title", "state", "project"]);
  assert.deepEqual(Object.keys(selected.blobs[0]), ["id", "state", "executionMode", "updatedAt"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stdout, /unknown field imaginary/u);
});

test("AXI project subcommands validate their own flags", () => {
  const fixture = createCliFixture();
  const result = runCli(fixture, ["project", "list", "--root", fixture.root]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown flag --root/u);
});

test("AXI home discovers the parent database and scopes ambient state to the current directory", () => {
  const fixture = createCliFixture();
  const databasePath = join(fixture.root, "pipelines", "axi-factorio.db");
  const appA = join(fixture.root, "apps", "a");
  const appB = join(fixture.root, "elsewhere", "b");
  mkdirSync(appA, { recursive: true });
  mkdirSync(appB, { recursive: true });
  mkdirSync(join(fixture.root, "pipelines"), { recursive: true });
  for (const [id, root] of [["app-a", appA], ["app-b", appB]]) {
    const added = runCli(fixture, [
      "project", "add", id, id, "--root", root, "--pipeline-root", fixture.root,
      "--pipeline", fixture.pipelinePath, "--db", databasePath, "--json",
    ]);
    assert.equal(added.status, 0, added.stderr || added.stdout);
  }

  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cliPath], {
    cwd: appA, encoding: "utf8",
  });
  const explicit = runCli(fixture, ["project", "list", "--db", databasePath, "--json"]);

  assert.equal(existsSync(databasePath), true);
  assert.match(explicit.stdout, /app-a/u);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /app-a/u);
  assert.doesNotMatch(result.stdout, /app-b/u);
  assert.equal(existsSync(join(appA, "pipelines", "axi-factorio.db")), false);
});

test("AXI version accepts the standard short flag", () => {
  const fixture = createCliFixture();
  const result = runCli(fixture, ["-v"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^axi-factorio /u);
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
    "project", "artifact", "endpoint", "add", "adopt", "relocate", "bind-execution", "list", "status", "show", "receipts",
    "play", "step", "stop", "retry", "review", "feedback", "approve", "reset-endpoint", "rebind-endpoint", "rewind",
    "kick", "run", "evaluate", "service", "setup", "init",
  ];
  for (const command of commands) {
    const result = runCli(fixture, [command, "--help"]);
    assert.equal(result.status, 0, command);
    assert.match(result.stdout, /^Usage: axi-factorio /, command);
    assert.match(result.stdout, /Examples:/u, command);
  }
});

test("grouped AXI actions expose action-specific help with defaults and examples", () => {
  const fixture = createCliFixture();
  for (const args of [
    ["project", "list", "--help"],
    ["endpoint", "declare", "--help"],
    ["service", "install", "--help"],
  ]) {
    const result = runCli(fixture, args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /default:/u);
    assert.match(result.stdout, /Examples:/u);
  }
});

test("AXI truncation includes the total size inline", () => {
  const fixture = createCliFixture();
  const body = "x".repeat(900);
  runCli(fixture, ["add", "long-body", "Long", "--pipeline", fixture.pipelinePath, "--body", body, "--json"]);
  const shown = JSON.parse(runCli(fixture, ["show", "long-body", "--json"]).stdout);

  assert.match(shown.blob.body, /truncated, 900 chars total/u);
  assert.match(shown.help[0], /--full/u);
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
  const declared = JSON.parse(runCli(fixture, [
    "endpoint", "declare", "blob-project", "--command", "npm",
    "--arg", "run", "--arg", "preview", "--health-path", "/healthz", "--json",
  ]).stdout);
  const endpoint = JSON.parse(runCli(fixture, ["endpoint", "show", "blob-project", "--json"]).stdout);

  assert.equal(project.project.defaultPipeline, "default");
  assert.equal(project.project.root, appRoot);
  assert.equal(project.project.pipelineRoot, join(fixture.root, "pipelines"));
  assert.equal(project.project.resolvedPipeline, "default/v1");
  assert.equal(updated.project.name, "Renamed App");
  assert.equal(updated.already, false);
  assert.equal(blob.blob.project, "app");
  assert.equal(shown.blob.cwd, appRoot);
  assert.equal(shown.blob.pipeline, "default/v1");
  assert.equal(declared.localEndpointDeclaration.workspaceRoot, appRoot);
  assert.equal(endpoint.localEndpointDeclaration.healthPath, "/healthz");
  assert.equal(existsSync(join(appRoot, ".axi-factorio", "local-endpoint.json")), false);
});

test("project remove is preview-first and requires exact confirmation plus evidence", () => {
  const fixture = createCliFixture();
  runCli(fixture, [
    "project", "add", "default", "Default", "--root", fixture.root,
    "--pipeline-root", fixture.root, "--pipeline", fixture.pipelinePath, "--json",
  ]);
  runCli(fixture, [
    "add", "remove-blob", "Remove blob", "--project", "default",
    "--pipeline", fixture.pipelinePath, "--json",
  ]);

  const preview = JSON.parse(runCli(fixture, ["project", "remove", "default", "--json"]).stdout);
  const missingEvidence = runCli(fixture, ["project", "remove", "default", "--confirm", "default", "--json"]);
  const removed = JSON.parse(runCli(fixture, [
    "project", "remove", "default", "--confirm", "default", "--evidence", "cleanup:test", "--json",
  ]).stdout);
  const listed = JSON.parse(runCli(fixture, ["project", "list", "--json"]).stdout);

  assert.equal(preview.preview.blobCount, 1);
  assert.match(preview.help[0], /--confirm default/u);
  assert.equal(missingEvidence.status, 1);
  assert.match(missingEvidence.stdout, /requires evidence/u);
  assert.equal(removed.removal.projectId, "default");
  assert.equal(listed.count, 0);
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

test("feedback --no-run records human input before a separate bounded Step", () => {
  const fixture = createCliFixture();
  runCli(fixture, [
    "add", "blob-bounded", "Review me once", "--pipeline", fixture.pipelinePath,
    "--cwd", fixture.root, "--json",
  ]);
  runCli(fixture, ["review", "blob-bounded", "--note", "Await decision", "--json"]);

  const feedback = JSON.parse(runCli(fixture, [
    "feedback", "blob-bounded", "Proceed once", "--evidence", "human:authorized",
    "--no-run", "--json",
  ]).stdout);
  const held = JSON.parse(runCli(fixture, ["show", "blob-bounded", "--json"]).stdout);
  runCli(fixture, ["step", "blob-bounded", "--json"]);
  const stepped = JSON.parse(runCli(fixture, ["show", "blob-bounded", "--json"]).stdout);

  assert.equal(feedback.scheduled, false);
  assert.equal(held.blob.runRequested, false);
  assert.equal(held.humanInputs.at(-1).text, "Proceed once");
  assert.equal(stepped.blob.runRequested, true);
  assert.equal(stepped.blob.executionMode, "continuous");
});

test("retry --once persists one receipt of work without replacing continuous preference", () => {
  const fixture = createCliFixture();
  runCli(fixture, [
    "add", "blob-retry-once", "Retry once", "--pipeline", fixture.pipelinePath,
    "--cwd", fixture.root, "--db", fixture.databasePath, "--json",
  ]);
  let database = new FactorioDatabase(fixture.databasePath);
  let store = new ConveyorStore(database);
  store.requestContinuous("blob-retry-once");
  const step = discoverPipeline(fixture.pipelinePath)[0];
  const claim = store.beginReceipt({
    blobId: "blob-retry-once", step,
    definition: snapshotDefinition(step, fixture.pipelinePath),
    adapter: "fixture", inputArtifacts: [],
  });
  store.failReceipt(claim.receipt.id, "fixture failure");
  database.close();

  const retried = JSON.parse(runCli(fixture, [
    "retry", "blob-retry-once", "--once", "--db", fixture.databasePath, "--json",
  ]).stdout);
  database = new FactorioDatabase(fixture.databasePath);
  store = new ConveyorStore(database);
  const blob = store.getBlob("blob-retry-once");
  database.close();

  assert.equal(retried.once, true);
  assert.equal(blob?.executionMode, "continuous");
  assert.equal(blob?.runRequested, true);
  assert.equal(blob?.singleTransitionRequested, true);
});

test("artifact verify advances an existing failed pip from declared file evidence without an agent", () => {
  const fixture = createCliFixture();
  writeFileSync(join(fixture.pipelinePath, "0.plan.define.exit.md"), "[Plan](artifacts/plan.md)");
  mkdirSync(join(fixture.root, "artifacts"));
  writeFileSync(join(fixture.root, "artifacts", "plan.md"), "accepted plan");
  runCli(fixture, [
    "add", "blob-artifact", "Artifact proof", "--pipeline", fixture.pipelinePath,
    "--cwd", fixture.root, "--db", fixture.databasePath, "--json",
  ]);
  const database = new FactorioDatabase(fixture.databasePath);
  const store = new ConveyorStore(database);
  store.requestContinuous("blob-artifact");
  const step = discoverPipeline(fixture.pipelinePath)[0];
  const claim = store.beginReceipt({
    blobId: "blob-artifact", step, definition: snapshotDefinition(step, fixture.pipelinePath),
    adapter: "fixture", inputArtifacts: [],
  });
  store.failReceipt(claim.receipt.id, "classifier unavailable");
  database.close();

  const verified = JSON.parse(runCli(fixture, [
    "artifact", "verify", "blob-artifact", "--db", fixture.databasePath, "--json",
  ]).stdout);

  assert.equal(verified.receipt.status, "advance");
  assert.deepEqual(verified.receipt.outputArtifacts, [`file:${join(fixture.root, "artifacts", "plan.md")}`]);
  assert.equal(verified.receipt.adapter, "artifact-presence");
});

test("adopt imports attested prior steps and positions existing work", () => {
  const fixture = createCliFixture();
  writeStep(fixture.pipelinePath, 1, "dev.build");
  writeStep(fixture.pipelinePath, 2, "workbench.review");
  runCli(fixture, [
    "add", "blob-adopt", "Existing work", "--pipeline", fixture.pipelinePath,
    "--cwd", fixture.root, "--json",
  ]);
  const steps = discoverPipeline(fixture.pipelinePath);
  const target = steps.at(-1)!;
  const evidence = steps.slice(0, -1).flatMap((step) => ["--evidence", `${step.id}=git:${step.id}`]);

  const adoption = runCli(fixture, [
    "adopt", "blob-adopt", target.id, "--source", "git-sha:abc123", ...evidence, "--json",
  ]);
  assert.equal(adoption.status, 0, adoption.stderr || adoption.stdout);
  const result = JSON.parse(adoption.stdout);
  const shown = JSON.parse(runCli(fixture, ["show", "blob-adopt", "--full", "--json"]).stdout);

  assert.equal(result.blob.state, target.id);
  assert(shown.receipts.every((receipt: { executionKind: string }) => receipt.executionKind === "imported"));
  assert(shown.receipts.every((receipt: { attestationSource: string }) => receipt.attestationSource === "git-sha:abc123"));
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
import { discoverPipeline, snapshotDefinition } from "../src/Pipeline.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorStore } from "../src/Store.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
