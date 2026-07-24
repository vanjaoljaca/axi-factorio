test("a delayed decision keeps its exact-head endpoint alive after the receipt ends", async () => {
  const scenario = new LocalEndpointScenario();
  try {
    const result = await scenario.play();
    const phases = result.frames.map((item) => item.visual.phase);
    const final = result.frames.at(-1)!;
    const healthy = result.frames.find((item) => item.visual.phase === "healthy")!;

    assert.deepEqual(phases, ["ready", "committed", "startup-timeout", "healthy", "exit-received-url", "receipt-ended"]);
    assert.equal(final.receipts[0].status, "blocked");
    assert.equal(final.visual.endpoint?.alive, true);
    assert.deepEqual(final.visual.endpoint?.args, ["--prefix", "apps/example", "run", "workbench"]);
    assert.equal(final.visual.endpoint?.cwd, final.visual.workspace);
    assert.equal(final.assertions.every((item) => item.passed), true);
    assert.equal((await fetch(healthy.visual.endpoint!.url)).status, 200);
    assertLegacyMigration();
  } finally {
    await scenario.dispose();
  }
});

test("service restart recovers the same durable local endpoint lease", async () => {
  const scenario = new LocalEndpointScenario();
  try {
    const before = (await scenario.play()).frames.at(-1)!.visual.endpoint!;
    const after = (await scenario.restart()).frames.at(-1)!.visual.endpoint!;
    assert.equal(after.url, before.url);
    assert.equal(after.gitHead, before.gitHead);
    assert.equal((await fetch(after.url)).status, 200);
  } finally {
    await scenario.dispose();
  }
});

test("poll reconciliation relaunches a retained endpoint after its child exits", async () => {
  const scenario = new LocalEndpointScenario();
  try {
    const before = (await scenario.play()).frames.at(-1)!.visual.endpoint!;
    const result = await scenario.recoverLostChild();
    const after = result.frames.at(-1)!.visual.endpoint!;

    assert.equal(result.frames.at(-2)!.visual.phase, "child-lost");
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.url, before.url);
    assert.equal(after.gitHead, before.gitHead);
    assert.equal((await fetch(after.url)).status, 200);
    assert.equal(result.frames.at(-1)!.assertions.find(
      (item) => item.label === "Dispatcher lease survived slow endpoint recovery",
    )?.passed, true);
  } finally {
    await scenario.dispose();
  }
});

test("healthy reconciliation polls reuse one adopted endpoint session without churn", async () => {
  const scenario = new LocalEndpointScenario();
  try {
    await scenario.play();
    const result = await scenario.pollStable();
    assert.equal(result.frames.at(-1)!.visual.phase, "stable");
  } finally {
    await scenario.dispose();
  }
});

test("the launchd-owned service hosts its Viewer without a competing child process", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "ServiceInstall.ts"), "utf8");
  assert.match(source, /createViewerServer/);
  assert.doesNotMatch(source, /spawn\(process\.execPath/);
});

test("approve durably terminates the owned local endpoint without an orphan", async () => {
  await assertDisposition("approve");
});

test("reject durably terminates the owned local endpoint without an orphan", async () => {
  await assertDisposition("reject");
});

test("reset terminates endpoint ownership before replacing its temporary fixture", async () => {
  const scenario = new LocalEndpointScenario();
  try {
    const url = (await scenario.play()).frames.at(-1)!.visual.endpoint!.url;
    const reset = await scenario.reset();
    assert.equal(reset.frames.length, 1);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
  } finally {
    await scenario.dispose();
  }
});

test("local endpoint supervisor rejects an uncommitted workspace before launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-dirty-review-"));
  try {
    writeFileSync(join(root, "endpoint.ts"), "throw new Error('must not launch');\n");
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "factorio@example.test"]);
    git(root, ["config", "user.name", "Factorio Fixture"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "Initial fixture"]);
    writeFileSync(join(root, "dirty.txt"), "not committed\n");
    await assert.rejects(new LocalEndpointSupervisor().start("dirty-run", root, {
      command: process.execPath, args: ["endpoint.ts"], healthPath: "/",
    }), /clean committed workspace head/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("endpoint children remain temporary supervisor processes, not app-specific launchd jobs", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "LocalEndpointSupervisor.ts"), "utf8");
  assert.doesNotMatch(source, /launchctl|LaunchAgent|ServiceInstall/);
  assert.match(source, /spawn\(declaration.command, declaration.args/);
});

function assertLegacyMigration(): void {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-endpoint-migration-"));
  const pipeline = join(root, "pipelines", "default", "v1");
  const database = new FactorioDatabase(join(root, "factorio.sqlite"));
  try {
    mkdirSync(pipeline, { recursive: true });
    writeFileSync(join(pipeline, "01.build.endpoint.entry.md"), "Build.");
    writeFileSync(join(pipeline, "01.build.endpoint.exit.md"), "Check.");
    mkdirSync(join(root, ".axi-factorio"), { recursive: true });
    writeFileSync(join(root, ".axi-factorio", "local-endpoint.json"), JSON.stringify({
      command: process.execPath, args: ["endpoint.ts"], healthPath: "/healthz",
    }));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "factorio@example.test"]);
    git(root, ["config", "user.name", "Factorio Fixture"]);
    git(root, ["add", "pipelines"]);
    git(root, ["commit", "-m", "Initial fixture"]);
    const store = new ConveyorStore(database);
    store.createBlob("legacy-endpoint", {
      title: "Legacy endpoint", body: "", cwd: root, executionWorkspaceRoot: root,
      pipelineId: "default/v1", pipelinePath: pipeline, inputArtifacts: [],
    });
    store.createBlob("legacy-endpoint-peer", {
      title: "Legacy endpoint peer", body: "", cwd: root, executionWorkspaceRoot: root,
      pipelineId: "default/v1", pipelinePath: pipeline, inputArtifacts: [],
    });

    const migrations = migrateLegacyLocalEndpointDeclarations(store);

    assert.equal(migrations[0]?.imported, true);
    assert.equal(migrations[0]?.removed, true);
    assert.equal(migrations.length, 2);
    assert.equal(existsSync(join(root, ".axi-factorio", "local-endpoint.json")), false);
    assert.deepEqual(store.getLocalEndpointDeclaration("legacy-endpoint"), {
      blobId: "legacy-endpoint", workspaceRoot: root, command: process.execPath,
      args: ["endpoint.ts"], healthPath: "/healthz",
      createdAt: store.getLocalEndpointDeclaration("legacy-endpoint")?.createdAt,
      updatedAt: store.getLocalEndpointDeclaration("legacy-endpoint")?.updatedAt,
    });
    assert.equal(store.getLocalEndpointDeclaration("legacy-endpoint-peer")?.healthPath, "/healthz");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function assertDisposition(action: "approve" | "reject"): Promise<void> {
  const scenario = new LocalEndpointScenario();
  try {
    const url = (await scenario.play()).frames.at(-1)!.visual.endpoint!.url;
    const result = await scenario[action]();
    const lease = result.frames.at(-1)!.visual.lease!;
    assert.equal(lease.desiredState, "stopped");
    assert.equal(lease.observedState, "stopped");
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
  } finally {
    await scenario.dispose();
  }
}

import { LocalEndpointScenario } from "../test/harness/LocalEndpointScenario.ts";
import {
  LocalEndpointSupervisor,
  migrateLegacyLocalEndpointDeclarations,
} from "../src/LocalEndpointSupervisor.ts";
import { FactorioDatabase } from "../src/Database.ts";
import { ConveyorStore } from "../src/Store.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
