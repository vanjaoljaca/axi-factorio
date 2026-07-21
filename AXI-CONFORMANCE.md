# AXI conformance audit

Audited against the ten Agent eXperience Interface principles and the complete
official AXI skill published at <https://axi.md/> on 2026-07-21.

| Principle | Status | Evidence |
| --- | --- | --- |
| Token-efficient output | pass | Default CLI output uses TOON; `--json` is an explicit escape hatch. |
| Minimal default schemas | pass | Blob, project, and receipt lists default to four fields. `--fields` requests named additional fields and rejects unknown names. |
| Content truncation | pass | Long blob bodies append the total character count and `--full` escape hatch inline; `show --full` returns the complete value. |
| Pre-computed aggregates | pass | Home and list output include state totals and shown-versus-total counts. |
| Definitive empty states | pass | Empty home/list/project/receipt queries report explicit zero counts and contextual empty messages. |
| Structured errors and exit codes | pass | Errors are structured on stdout, diagnostics stay on stderr, mutations expose no-ops, per-action unknown flags exit 2 with valid alternatives, runtime failures exit 1, and commands never prompt. |
| Ambient context | pass | Explicit `setup hooks` uses pinned `axi-sdk-js` to install or repair SessionStart integrations for Claude Code, Codex, and OpenCode. The home view discovers the nearest parent DB and scopes projects to the working directory. A generated installable skill ships from the same guidance source. |
| Content first | pass | No arguments show directory-relevant live data, executable path, description, aggregates, and next actions instead of help. |
| Contextual disclosure | pass | Command output includes concrete `help` suggestions for likely next actions. |
| Consistent help | pass | Root, every public command, and grouped project/service actions support concise `--help` with flags, defaults, and examples. Both `-v` and `--version` work. The internal Workbench is not advertised. |

## Verdict

The CLI conforms to all ten published AXI principles as a self-audited
implementation. `tests/AxiConformance.test.ts` and `tests/Cli.test.ts` make the
previously missing ambient-context, generated-skill, field-selection,
directory-scope, help, truncation, and error behavior executable.

AXI defines design principles rather than a third-party certification program;
this document therefore reports evidence, not an external certification badge.
The official SDK's registry-backed `update` convenience is intentionally not
exposed until `axi-factorio` is published to npm; `update` is SDK ergonomics,
not one of the ten conformance principles.
