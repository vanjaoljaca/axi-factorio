# Viewer Design QA

- Source visual truth: `/var/folders/1k/t27wrtf95gjfjtwxy5kfd0r00000gp/T/codex-clipboard-50e501b4-79e6-4285-a329-4f0cfec33393.png`
- Implementation screenshot: `evidence/viewer/matrix-fixture.png`
- Full-view comparison evidence: `evidence/viewer/comparison.png`
- Viewport: 1280 × 720 combined review; implementation frame rendered from the 1280px desktop fixture, light mode
- State: three projects, three tasks, three checked-in pipeline groups, including one empty project

## Findings

No actionable P0, P1, or P2 mismatch remains.

- Fonts and typography: the system sans hierarchy, compact labels, weights, and muted secondary text follow the supplied dashboard. The implementation intentionally uses text labels instead of approximated source icons.
- Spacing and layout rhythm: the narrow rail, shallow header, grouped step bands, sticky task-name column, project sections, and compact bead rows match the source structure. The fixture has fewer steps and tasks, so it correctly contains more open canvas.
- Colors and visual tokens: the implementation preserves the white canvas, subtle gray rules, pale group bands, green completion, blue current-step ring, purple later-group state, and red blocked state.
- Image quality and asset fidelity: no source product asset was approximated. Nonessential source icons were omitted because the package does not yet ship a matching icon asset library.
- Copy and content: labels come from actual projects and checked-in pipeline step filenames. The current-state legend says “Current step” rather than “In progress” because a blob position does not prove that a worker is running.

## Interaction Evidence

- Search filtered the matrix to the matching task and project.
- Project collapse removed the task rows and correctly updated `aria-expanded`.
- Refresh and five-second polling loaded the current SQLite projection.
- An empty project still displayed the groups and steps from its checked-in default pipeline.
- Browser console errors checked: none.

## Focused Region Comparison

No additional crop was needed. The full-view combined comparison keeps the header bands, step labels, task-name column, bead tracks, and legend readable at the tested scale.

## Comparison History

- Initial pass: the viewer only derived columns from blobs, so an empty project could not establish the shared pipeline matrix.
- Fix: load the latest checked-in default pipeline for each project and merge those stable steps into the shared columns.
- Post-fix evidence: `evidence/viewer/comparison.png`; `matrix-fixture.png` is the exact implementation frame from this comparison, and the empty Mobile App project remains visible while G1/G2/G3 render.

## Final Result

final result: passed
