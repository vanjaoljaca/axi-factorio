# axi-factorio

> **Work in progress.** This is an early public release candidate. The storage
> model, CLI, adapter lifecycle, and UI are still being actively shaped.

![axi-factorio scenario workbench](workbench-implementation.png)

`axi-factorio` is a deliberately dumb local blob conveyor. Blobs move downward
through ordered steps defined by ordinary Markdown files in Git. SQLite stores
runtime state and one receipt for every execution.

There is no workflow DSL, pipeline-version object, event bus, dependency graph,
or durable-workflow engine.

## Internal development workbench

The source repo contains a scenario lab for developing axi-factorio itself:

```sh
npm run workbench
```

Then open `http://127.0.0.1:4318`. Use `-- --db path/to/factorio.db` to inspect
a specific runtime database. The scenario lab and database inspector render
through the same conveyor, receipt-stream, and assertion views.

Port `4317` belongs to the installed user viewer. The Workbench defaults to
`4318` and refuses to start on the configured viewer port. When the viewer uses
a non-default port, pass it with `-- --viewer-port <port>`.

The default happy-path scenario calls `createTestHarness()`, loads the paired
definitions in `test/harness/default/`, creates a fresh temporary SQLite
database, and moves a blob through the real `ConveyorRunner`.

The workbench is not included in the release artifact or exposed as an
installed CLI command. The installed service has a separate read-only user
view: project-grouped task rows, pipeline beads, status, and updated time. Raw
receipts, assertions, scenario playback, and database paths stay in the source
workbench.

## Model

The database has five small concerns:

- `projects` separates each app working root from its shared pipeline-definition
  root and stores a default pipeline selector;
- `blobs` stores incoming work and its current conveyor position;
- `receipts` records every step execution and its definition identity;
- `humanInputs` appends review, feedback, and approval evidence; and
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

Human-gated work can remain on one step and one external Codex task across
multiple feedback cycles. Each resumed receipt snapshots the fresh human input,
the reused task ID, and any approval evidence.

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

The files are the authority. The database records the pipeline identity selected
for each blob, such as `default/v1`, but contains no pipeline definition objects
or frozen step arrays. A receipt captures the exact Git SHA and combined
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
When fresh human input is appended at the current step, the next receipt resumes
that same Codex thread before evaluating the exit prompt again.

In rc.8, continuation is intentionally step-scoped: retries, blocked reviews,
feedback, and approval cycles reuse the current step's Codex thread, while the
next pipeline step starts a fresh thread. This preserves phase isolation but
repays Codex's startup context cost at every step. Reusing one blob-owned thread
across ordinary steps is a separate adapter-lifecycle decision, not an implicit
rc.8 behavior.
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

- `axi-factorio-0.1.0-rc.8.tgz`, the installable package;
- `SHA256SUMS`, for artifact verification; and
- `INSTALL.md`, with direct and vendored installation commands.

Do not use `npm link` for a consuming project. Install the exact tarball so
`package.json` and its lockfile identify the tested release candidate.

## Commands

Install the exact candidate in the consuming npm project:

```sh
npm install --save-exact /path/to/axi-factorio-0.1.0-rc.8.tgz
```

From the consuming project root, the defaults are:

```text
pipeline name:  default
pipeline:       ./pipelines/default/<highest-vN>
database:       ./pipelines/axi-factorio.db
```

Adding a blob resolves the highest numbered version currently present and saves
that concrete identity in SQLite. For example, if `v1` and `v2` exist, a new
blob stores `default/v2`; existing blobs remain pinned to the version selected
when they were created. A future `./.factorio` file may override these defaults.

Every blob belongs to a project. A project stores the app working root, a
separate shared pipeline-definition root, and a default pipeline selector.
Register or update each app explicitly:

```sh
npx axi-factorio project upsert example "Example" \
  --root ./apps/example \
  --pipeline-root ./pipelines \
  --pipeline default
npx axi-factorio project list
npx axi-factorio project show example
```

Add a blob with a caller-owned join ID:

```sh
npx axi-factorio add account-export-1 "Add account export" \
  --project example \
  --body-file ./ticket.md \
  --input-ref ticket:account-export-1
```

`--input-ref` may be repeated. `--mint` generates an ID. Repeating an identical
add is an idempotent no-op.

Run one item or keep the conveyor moving:

```sh
npx axi-factorio run
npx axi-factorio service
```

The foreground service owns both the automated runner and the read-only web
view at `http://127.0.0.1:4317`. Install it as a macOS user service from the
consuming project root:

```sh
npx axi-factorio service install
npx axi-factorio service status
npx axi-factorio service uninstall
```

Inspect state and receipts:

```sh
npx axi-factorio
npx axi-factorio list --state plan.define
npx axi-factorio show account-export-1 --full
npx axi-factorio receipts account-export-1 --full
```

Restart a blob paused by a failed or blocked receipt:

```sh
npx axi-factorio retry account-export-1
```

Adopt existing work at a later step by attesting every completed prior step:

```sh
npx axi-factorio adopt account-export-1 workbench.review \
  --source git-sha:0123456789abcdef \
  --evidence plan.define=review:plan \
  --evidence dev.build=commit:0123456789abcdef \
  --evidence qa.check=test-run:4821
```

The source must be an explicit `kind:value` identity, and every prior step must
have at least one `STEP_ID=REF` evidence value in pipeline order. Adoption is
only allowed before any receipts exist. It writes completed receipts marked
`executionKind: imported` and `adapter: attested-import`; it never claims an
automation run occurred.

Append iterative human review input at the current step:

```sh
npx axi-factorio review account-export-1 --note "Await Workbench review"
npx axi-factorio feedback account-export-1 "Reduce the visual chrome" \
  --evidence voice-note:1
npx axi-factorio approve account-export-1 \
  --note "Approved at exact head" \
  --evidence git-head:abc123
```

Feedback and approval unpause the blob so the service can resume its current
external task. Approval requires at least one evidence reference. The prompt
still decides whether the step passes; Factorio only supplies and records the
human evidence.

Opening an rc.4, rc.5, rc.6, or rc.7 database with rc.8 migrates projects and receipt
provenance columns automatically. The old
project `cwd` becomes the app root, and its initial pipeline root becomes
`<old-cwd>/pipelines`. Run `project upsert` afterward to point projects at a
shared workspace pipeline root.

## Viewer state language

Pipeline position is neutral: completed work uses a solid checked bead, current
work an outlined bead, and pending work a muted bead. Imported completion uses
a dashed checked diamond so attested work remains visibly distinct without a
new position color. Paused blobs with no receipts are neutral `Inventory`, not
blocked work. Orange means human attention is needed; red is reserved for
failure or broken execution.

Future multi-pipeline integration is deliberately parked in [ROADMAP.md](ROADMAP.md)
under **pipeline merger**. rc.8 does not implement it.

Explicitly move it back to a step:

```sh
npx axi-factorio rewind account-export-1 plan.research
npx axi-factorio kick account-export-1 dev.workbench
```

Both commands invalidate receipts for the target step and later steps, set the
target as the next step, and leave earlier valid receipts intact.

Use `--db PATH` or `AXI_FACTORIO_DB` to choose another SQLite file.

## AXI behavior

The CLI implements nine of the ten published AXI principles. See
[`AXI-CONFORMANCE.md`](AXI-CONFORMANCE.md) for the evidence and the remaining
ambient-context gap. Its current agent-facing behavior includes:

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
