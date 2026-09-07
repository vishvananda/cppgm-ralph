Implement `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- full primary log: `{{lastTestLogPath}}`

Before editing, read `AGENTS.md`, `TESTING_AND_REFERENCES.md`, `spec.md`,
`{{testStage}}/README.md`, and the relevant required tests. Keep personal tests in `student.tests/`
and run them explicitly; `tests/regression/` fixtures are outside the course
exit criteria. Treat `spec.md` as the
normative architecture for the completed compiler. Apply its requirements that
are relevant to this stage and preserve a path toward the full design without
pulling later assignment behavior into the current PA.

Keep `{{testStage}}/plan.md` compact with Stage Design and Spec Alignment,
Current Failure Map, Active Checkpoint, Performance Evidence, and a Completed
Checkpoints ledger. Replace superseded state and use one concise ledger row per
completed checkpoint.

Group the complete current-PA failure set by shared behavior and ownership.
Select a substantial checkpoint at a stable compiler boundary, bundling related
small groups when appropriate. Before implementation, record the relevant spec
requirements, owner and data flow, expected complexity, and validation.

Build the next coherent increment of the same compiler and preserve previous
assignments. Use `spec.md` to guide representations, phase boundaries, demand,
lookup, lowering, allocation, and complexity. Measure representative cases for
scaling-sensitive or unexpectedly slow work and record the evidence.

Ralph separately checks assignments through the previous PA and the current
PA-local report. Before returning, complete the selected checkpoint, reduce
the current-PA failure count below the turn-start baseline or finish the PA,
without reducing test coverage. Adding passing tests while retaining every
existing failure does not count as checkpoint progress. Keep file audit
passing, refresh the compact plan, commit cohesive progress, and leave
`git status --short` empty.

Required exit criteria:
{{modelValidation}}
