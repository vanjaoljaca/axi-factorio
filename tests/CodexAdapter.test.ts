test("runs entry and exit in one Codex thread through the adapter contract", async () => {
  const fixture = createAdapterFixture();
  const externalRuns: string[] = [];

  const result = await fixture.adapter.execute(adapterInput(fixture), (externalRunId) => externalRuns.push(externalRunId));

  assert.equal(result.externalRunId, "thread-fixture");
  assert.equal(result.status, "advance");
  assert.deepEqual(result.outputArtifacts, ["commit:abc", "codex-thread:thread-fixture"]);
  assert.match(readFileSync(fixture.argsLog, "utf8"), /resume thread-fixture/);
  assert.equal(readFileSync(fixture.argsLog, "utf8").match(new RegExp(`-C ${fixture.root}`, "g"))?.length, 2);
  assert.deepEqual(externalRuns, ["thread-fixture", "thread-fixture"]);
});

test("rejects Windows before starting Codex", () => {
  assert.throws(
    () => new CodexAdapter("win32"),
    /unsupported on Windows because process-tree termination cannot be guaranteed/,
  );
});

test("rejects malformed Codex JSONL", async () => {
  const fixture = createAdapterFixture();
  process.env.FAKE_CODEX_MODE = "malformed";
  try {
    await assert.rejects(fixture.adapter.execute(adapterInput(fixture), () => undefined), SyntaxError);
  } finally {
    delete process.env.FAKE_CODEX_MODE;
  }
});

test("propagates external-run persistence failures", async () => {
  const fixture = createAdapterFixture();
  await assert.rejects(
    fixture.adapter.execute(adapterInput(fixture), () => {
      throw new Error("event persistence failed");
    }),
    /event persistence failed/,
  );
});

test("waits for the Codex process tree after an event failure", async () => {
  const fixture = createAdapterFixture();
  const stopped = join(fixture.root, "stopped");
  process.env.FAKE_CODEX_MODE = "descendant";
  process.env.FAKE_CODEX_STOPPED = stopped;
  try {
    await assert.rejects(fixture.adapter.execute(adapterInput(fixture), () => {
      throw new Error("stop tree");
    }), /stop tree/);
    assert.equal(readFileSync(stopped, "utf8"), "stopped");
  } finally {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_STOPPED;
  }
});

function createAdapterFixture(): AdapterFixture {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-codex-"));
  const bin = join(root, "bin");
  const argsLog = join(root, "args.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), fakeCodex);
  chmodSync(join(bin, "codex"), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  process.env.FAKE_CODEX_ARGS = argsLog;
  return { root, argsLog, adapter: new CodexAdapter() };
}

function adapterInput(fixture: AdapterFixture): AdapterInput {
  return {
    blob: {
      id: "blob-1",
      title: "Test",
      body: "Do it",
      cwd: fixture.root,
      pipelinePath: fixture.root,
      inputArtifacts: ["ticket:1"],
      state: "running",
      lastCompletedStepId: null,
      lastCompletedOrder: null,
      forcedStepId: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    },
    step: { id: "plan.define", order: 0, entryPath: "", exitPath: "" },
    definition: { gitSha: "a".repeat(40), contentHash: "b".repeat(64), entry: "entry", exit: "exit" },
    inputArtifacts: ["ticket:1"],
  };
}

const fakeCodex = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_ARGS"
if [ "$FAKE_CODEX_MODE" = "malformed" ]; then
  printf '%s\\n' '{not-json}'
  exit 0
fi
if [ "$FAKE_CODEX_MODE" = "descendant" ]; then
  (trap 'printf stopped > "$FAKE_CODEX_STOPPED"; exit 0' TERM; printf ready > "$FAKE_CODEX_STOPPED.ready"; while :; do sleep 1; done) &
  while [ ! -e "$FAKE_CODEX_STOPPED.ready" ]; do sleep 0.01; done
  rm "$FAKE_CODEX_STOPPED.ready"
  printf '%s\\n' '{"type":"thread.started","thread_id":"thread-fixture"}'
  while :; do sleep 1; done
fi
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-fixture"}'
case " $* " in
  *" resume "*)
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"decision\\":\\"advance\\",\\"reason\\":\\"ready\\",\\"outputArtifacts\\":[\\"commit:abc\\"]}"}}'
    ;;
  *)
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"entry complete"}}'
    ;;
esac
printf '%s\\n' '{"type":"turn.completed"}'
`;

type AdapterFixture = { root: string; argsLog: string; adapter: CodexAdapter };

import type { AdapterInput } from "../src/Types.ts";
import { CodexAdapter } from "../src/CodexAdapter.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
