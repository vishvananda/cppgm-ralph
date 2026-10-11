Implement PA34 inception.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Read the root instructions/spec, `pa34/README.md`, its Makefile and source
sets. PA34 adds no language feature: trace seed/self output, crash, memory or
speed divergence to the owning compiler surface. Keep host toolchain, flags,
object roots and linking consistent. Do not rewrite valid source to evade a
code-generation defect.

Use the handout's host regressions, self-test ladder, pptoken comparison and
canonical inception in order. Diagnose the first divergence with focused
source/object reducers and spec section 11's scoped measurements. Reuse valid
unchanged evidence; do not run full seed/self campaigns after every local fix.
PA35 owns the broader optimization gates. Continue related repairs and keep a
compact `pa34/plan.md` with ownership, evidence and remaining divergences.

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
