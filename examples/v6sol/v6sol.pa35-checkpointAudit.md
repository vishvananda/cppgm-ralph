Review accumulated PA35 optimization changes.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Review all commits since the last reviewed code tip, the handout/spec,
architecture, transformation legality, reducers and required generated controls.
Separate compiler work from generated-code effects and verify constant-source
A/B attribution, identical output, build/link flags and allocator assumptions.

Preserve measured rung progress. Do not rerun validation the handoff checks
already passed; run a check only to confirm a fix you made, and refresh a
canonical group only if that fix changed the compiler. Do not change limits,
inputs, measurements or timestamps. Earlier through-PA33 and the file audit
pass; run inception when the changed surface can affect self-compilation.
Record the reviewed code tip, compact findings/evidence deltas and ledger.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native phase goal. Return a validated handoff, call `update_goal`
with status `complete`, and finish the turn. Partial completion ends a turn,
not the assignment. Never create or replace goals, edit Ralph state, or wait
for Ralph-owned checks.
