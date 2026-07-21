export const axiDescription = "Move blobs down Git-defined pipeline steps with SQLite receipts.";

export const axiHomeHelp = [
  "Run `axi-factorio show <id>` for one blob and its receipts.",
  "Run `axi-factorio list --fields id,title,state,project` to query blobs.",
  "Run `axi-factorio add <id> \"<title>\"` to add a blob.",
];

export function axiFactorioSkill(): string {
  return `---
name: axi-factorio
description: Inspect and operate local axi-factorio blob pipelines, execution state, receipts, and human gates.
---

# axi-factorio

${axiDescription}

Run \`axi-factorio\` first. Its compact home view is directory-scoped and shows
the live projects and blobs relevant to the current workspace.

Use these discovery paths:

- \`axi-factorio list --fields id,title,state,project\` lists compact blob state.
- \`axi-factorio show <id>\` shows one blob and its recent receipts.
- \`axi-factorio receipts <id> --full\` shows full receipt provenance.
- \`axi-factorio project list\` lists project defaults and resolved pipelines.
- \`axi-factorio <command> --help\` gives flags, defaults, and examples.

Execution is explicit: use \`step <id>\` for one transition, \`play <id>\` for
continuous progression, and \`stop <id>\` to clear a pending request. Human
gates use \`feedback\` and \`approve\` with evidence. Never infer approval.

The CLI emits TOON by default. Use \`--json\` only when programmatic JSON is
required, \`--fields\` to request additional list fields, and \`--full\` only
when truncated content or full receipt provenance is necessary.
`;
}
