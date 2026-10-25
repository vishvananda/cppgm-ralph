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

Apply the spec to supported capabilities from their first implementation.
Validate affected correctness, required reuse and bounded work; reuse valid
qualified evidence under section 11. Investigate demonstrated excess, including
repeated linear work, without expanding unrelated checks. Generated-code
acceptance belongs to its owning assignment.

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

Ralph owns the native `/goal`. Return a validated handoff; its completion check
ends the phase. Partial completion ends a turn, not the assignment. Never clear
or replace the goal, edit Ralph state, or wait for Ralph-owned checks.
