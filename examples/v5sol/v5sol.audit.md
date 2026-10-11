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

Follow spec section 11. Review the fixed evidence set for missing or invalidated
results; measure those after fixes stabilize and reuse unchanged qualification,
host and baseline data. Complete coverage means relevant supported capabilities,
not every historical input. Profile demonstrated excessive work; a slow rank
alone is not a defect. Refresh canonical course acceptance on final code.
Do not turn final review into repeated exploratory benchmark campaigns.

Consolidate plan/audit once: alignment, findings, changes, evidence links,
validation and handoff ledger. Earlier stages and the shipped file audit pass.
No known stage correctness or architecture defect remains.

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
