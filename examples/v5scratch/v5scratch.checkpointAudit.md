Build the compiler in safe Rust from the student handouts and fixtures.
Use supplied reference binaries only for their documented course roles.
Do not consult another implementation or require clone-style byte identity.

Audit accumulated `{{testStage}}` implementation.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Read the spec, handout, plan and every source change since `Last reviewed
commit`; use `Stage base commit` for the first review and recover a missing
boundary from history. Review interactions and supported architecture across
that range, not just the latest commit. Fix violations at their owning paths
and use focused language/reference comparisons beyond fixtures.

Use existing evidence and spec section 11. Refresh only affected correctness,
scaling and performance controls. A shared change requires representative
consumer smokes; it does not authorize a historical matrix rerun. Profile a
measured excess before optimizing. Record unresolved uncertainty rather than
expanding measurements without a question. Preserve the checkpoint's course
progress and earlier-stage behavior.

After code fixes and validation, record that code tip as `Last reviewed commit`.
Commit a compact plan/audit delta and one ledger row without further code edits.
Distinguish unfinished implementation from review questions; neither is waived.

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
