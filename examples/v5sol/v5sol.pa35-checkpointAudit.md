Review accumulated PA35 optimization changes.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Review all commits since the last reviewed code tip, the handout/spec,
architecture, transformation legality, reducers and required generated controls.
Separate compiler work from generated-code effects and verify constant-source
A/B attribution, identical output, build/link flags and allocator assumptions.

Preserve measured rung progress. `test-progress` is a read-only summary: verify
that affected group results correspond to current code and unchanged results
have valid provenance. Refresh only invalidated groups; use smoke/quick and
bounded owner diagnostics rather than repeating full simulation. Do not change
limits, inputs, measurements or timestamps. Earlier through-PA33 and the file
audit pass; run inception when the changed surface can affect self-compilation.
Record the reviewed code tip, compact findings/evidence deltas and ledger.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph creates and schedules the native phase goal. Satisfy this phase, call
`update_goal` with status `complete`, and return a validated handoff. Partial
implementation completion ends this turn, not the assignment. Never create or
replace the goal, edit its state, or wait for Ralph-owned checks.
