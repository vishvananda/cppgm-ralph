Implement `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Read `AGENTS.md`, `TESTING_AND_REFERENCES.md`, `spec.md` and the owning
handout, including its design/scale guidance. Implement related facts and their
consumers together; continue while the same understanding enables progress.
A commit or minimum test gain is not a handoff boundary. Fix known correctness
and architecture defects without opening unrelated optimization investigations.

Apply spec architecture to supported capabilities from their first version.
Validate changed owners with focused correctness and scaling controls. Follow
spec section 11: state a measurement question, qualify the whole selected set
first, measure affected inputs after code stabilizes and reuse valid evidence.
No routine whole-stage/host matrix refresh; expand only for a demonstrated
regression or an uncovered affected consumer. Generated-code acceptance is
owned by the later assignments, especially PA35.

Before editing, record HEAD as `Stage base commit` and `Last reviewed commit`
in the compact stage plan. Keep decisions, remaining behavior groups, evidence
links and a handoff ledger; old plans do not override current instructions.
Earlier PAs and the shipped file audit pass; current failures decrease without
reduced coverage. For a partial handoff finish a coherent group and explain why
further related work is impractical. Ralph reviews every third incomplete
handoff and independently audits a passing stage.

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
