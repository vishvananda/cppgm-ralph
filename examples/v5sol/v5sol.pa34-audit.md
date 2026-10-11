Audit PA34 inception.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Independently review the stage changes, handout, spec, source ownership,
self-test ladder and inception comparisons. Verify deterministic seed/self
outputs, equal toolchain/link assumptions and the same production paths.
Trace shortcuts, divergence and timeout/OOM workarounds to their owning cause;
check earlier contracts and the supported architecture.

Use focused existing performance evidence; fill only missing or invalidated
measurements under spec section 11. Distinguish miscompilation, changed work and
generated-code quality. Refresh the canonical PA34 ladder and inception checks
on final code. Broader optimization work belongs to PA35.
Consolidate compact `pa34/plan.md` and `pa34/audit.md` with findings, fixes,
evidence links and final validation.

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
