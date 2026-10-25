Independently audit completed `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Read the handout, spec, plan, stage history and source. Reconstruct the
whole-stage architecture and review required capability families and their
interactions. Cite concrete owners for the spec's supported invariants; fix
violations and correctness defects rather than treating fixtures as proof.
Do not audit later capabilities as though they already exist.

Trace supported results through producers and consumers. Show what is reused
and what requires new work; proportional growth alone does not establish
efficient reuse. Under spec section 11, refresh only missing or invalidated
evidence after fixes stabilize; reuse valid qualification and host/baseline data.
Review supported capabilities, not every historical input. Refresh canonical
course acceptance on final code.

Consolidate plan/audit once: alignment, findings, changes, evidence links,
validation and handoff ledger. Earlier stages and the shipped file audit pass.
No known stage correctness or architecture defect remains.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native `/goal`. Return a validated handoff; its completion check
ends the phase. Partial completion ends a turn, not the assignment. Never clear
or replace the goal, edit Ralph state, or wait for Ralph-owned checks.
