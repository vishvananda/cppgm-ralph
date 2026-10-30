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

Trace affected results through producers and consumers. Show what is reused
and what requires new work; proportional growth alone does not establish
efficient reuse. Check common-record growth, optional payloads and scratch
lifetimes; reuse unchanged storage measurements. Under spec section 11,
refresh only missing or invalidated affected evidence. Shared changes need
representative consumer smokes. Record uncertainty; preserve checkpoint
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

Ralph owns the native phase goal. Return a validated handoff, call `update_goal`
with status `complete`, and finish the turn. Partial completion ends a turn,
not the assignment. Never create or replace goals, edit Ralph state, or wait
for Ralph-owned checks.
