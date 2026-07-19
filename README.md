# axi-factorio

`axi-factorio` is a deliberately dumb local blob conveyor. Blobs move downward
through ordered steps defined by ordinary Markdown files in Git. SQLite stores
runtime state and one receipt for every execution.

There is no workflow DSL, pipeline-version object, event bus, dependency graph,
or durable-workflow engine.

## Workbench

Launch the local scenario lab and SQLite viewer:

```sh
npm run workbench
```

Then open `http://127.0.0.1:4317`. Use `-- --db path/to/factorio.db` to inspect
a specific runtime database. The scenario lab and database inspector render
through the same conveyor, receipt-stream, and assertion views.

From an installed release, launch the same viewer with:

```sh
npx axi-factorio workbench --db path/to/factorio.db
```

The default happy-path scenario calls `createTestHarness()`, loads the paired
definitions in `test/harness/default/`, creates a fresh temporary SQLite
database, and moves a blob through the real `ConveyorRunner`.

## Model

The database has three small concerns:

- `blobs` stores incoming work and its current conveyor position;
- `receipts` records every step execution and its definition identity;
- `dispatcherLeases` ensures one local runner owns execution at a time.

`blob.state` is conveyor position, not execution status. A blob on the default
test harness moves through `g1.first`, `g2.second`, `g3.third`, then
`complete`. Running, failed, blocked, retry, and interrupted are receipt
statuses. A failed or blocked blob remains positioned at the responsible step
and is paused until explicitly retried.

Each receipt includes the blob ID, stable step ID, status, timestamps, adapter,
definition Git SHA, definition content hash, input/output artifact references,
and adapter run ID when available. Rewound receipts remain visible with an
`invalidatedAt` timestamp.

## Pipeline files

A pipeline is a directory of paired Markdown files:

```text
0.plan.define.entry.md
0.plan.define.exit.md
1.plan.research.entry.md
1.plan.research.exit.md
2.dev.workbench.entry.md
2.dev.workbench.exit.md
```

The number controls ordering. The stable step ID excludes it: the examples
above are `plan.define`, `plan.research`, and `dev.workbench`. Changing a number
reorders a step without changing its identity.

Definitions are read when a blob becomes runnable:

- changing an unexecuted step uses the current file;
- inserting a step before the last completed step does not pull a blob back;
- adding steps after a completed blob does not reopen it; and
- `rewind` or `kick` explicitly moves a blob to a named step and invalidates
  receipts for that step and everything after it.

The files are the authority. The database does not contain pipeline versions or
frozen step arrays. A receipt captures the exact Git SHA and combined
entry/exit SHA-256 content hash used for that execution.

## Adapter contract

The runner depends on a narrow `ToolAdapter` interface. An adapter receives the
blob, current step definition, and input artifact references, then returns:

- `advance`, `retry`, or `blocked`;
- a concise reason;
- output artifact references; and
- an optional external run ID.

Codex is the first adapter. It runs the entry prompt with `codex exec --json`,
records the Codex thread ID, and resumes that same thread with the exit prompt.
The exit result supplies output artifact references, and the adapter also adds
the Codex thread as a receipt artifact. The runner itself has no Codex-specific
state.

## Requirements

- Node.js 23.6 or newer for native TypeScript execution and `node:sqlite`;
- an installed and authenticated `codex` CLI for the included adapter;
- pipeline definitions inside a Git repository; and
- macOS or Linux. Windows is rejected because safe process-tree termination
  cannot be guaranteed.

## Install

Build an installable release candidate:

```sh
npm run build
```

This recreates `release/` with:

- `axi-factorio-0.1.0-rc.1.tgz`, the installable package;
- `SHA256SUMS`, for artifact verification; and
- `INSTALL.md`, with direct and vendored installation commands.

Do not use `npm link` for a consuming project. Install the exact tarball so
`package.json` and its lockfile identify the tested release candidate.

## Commands

Add a blob with a caller-owned join ID:

```sh
axi-factorio add account-export-1 "Add account export" \
  --pipeline ../pipelines/app-feature/v1 \
  --cwd ../apps/example \
  --body-file ./ticket.md \
  --input-ref ticket:account-export-1
```

`--input-ref` may be repeated. `--mint` generates an ID. Repeating an identical
add is an idempotent no-op.

Run one item or keep the conveyor moving:

```sh
axi-factorio run
axi-factorio service
```

Inspect state and receipts:

```sh
axi-factorio
axi-factorio list --state plan.define
axi-factorio show account-export-1 --full
axi-factorio receipts account-export-1 --full
```

Restart a blob paused by a failed or blocked receipt:

```sh
axi-factorio retry account-export-1
```

Explicitly move it back to a step:

```sh
axi-factorio rewind account-export-1 plan.research
axi-factorio kick account-export-1 dev.workbench
```

Both commands invalidate receipts for the target step and later steps, set the
target as the next step, and leave earlier valid receipts intact.

Use `--db PATH` or `AXI_FACTORIO_DB` to choose the SQLite file. The default is
`.axi-factorio/factorio.sqlite`.

## AXI behavior

The CLI follows the published AXI/tasks-axi house style:

- no arguments shows a content-first dashboard;
- stdout is compact TOON by default and `--json` is available everywhere;
- long content and receipt detail require `--full`;
- writes lead with `ok`, report `already` on no-ops, and give contextual help;
- unknown flags fail closed; and
- usage errors exit `2`, runtime failures exit `1`, and success/no-op exits `0`.

## Development

```sh
npm run check
npm test
npm run build
```

Pipeline routing, fan-out, and multiple adapters can be added later without
changing the linear blob/receipt model.
