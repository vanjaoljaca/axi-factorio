# AXI conformance audit

Audited against the ten Agent eXperience Interface principles published at
<https://axi.md/> on 2026-07-19.

| Principle | Status | Evidence |
| --- | --- | --- |
| Token-efficient output | pass | Default CLI output uses TOON; `--json` is an explicit escape hatch. |
| Minimal default schemas | pass | List/home blob summaries expose four fields: ID, title, project, and state. |
| Content truncation | pass | Long blob bodies are capped by default and `show --full` exposes the complete value with a total-size hint. |
| Pre-computed aggregates | pass | Home and list output include state totals and shown-versus-total counts. |
| Definitive empty states | pass | Empty home/list output reports zero counts and an explicit empty blob collection. |
| Structured errors and exit codes | pass | Errors are structured on stdout, diagnostics are JSON on stderr, mutations are idempotent, unknown flags exit 2, and runtime failures exit 1. |
| Ambient context | gap | `service install` is opt-in runtime installation, but axi-factorio does not yet install an agent session hook or generated Agent Skill that surfaces the conveyor at session start. |
| Content first | pass | No arguments show current conveyor data, executable path, description, aggregates, and next actions instead of help. |
| Contextual disclosure | pass | Command output includes concrete `help` suggestions for likely next actions. |
| Consistent help | pass | Root and every public subcommand support concise `--help`; the internal workbench is not advertised. |

## Verdict

The rc.7 CLI conforms to nine of the ten published AXI principles. It is not
yet accurate to claim complete AXI conformance because ambient agent context is
missing. The `axi-` name currently describes the interface direction and the
nine implemented principles, not a completed certification.

The next conformance increment is an explicit, reversible setup command that
installs directory-scoped session context and an Agent Skill from one generated
source so the CLI help and agent guidance cannot drift.
