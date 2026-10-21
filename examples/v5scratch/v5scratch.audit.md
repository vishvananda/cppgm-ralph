Build the compiler in safe Rust from the student handouts and fixtures.
Use supplied reference binaries only for their documented course roles.
Do not consult another implementation or require clone-style byte identity.

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

Follow spec section 11. Review complete supported coverage; refresh only missing
or invalidated evidence after fixes stabilize. Reuse host/baseline data and
qualification; profile demonstrated excess. Avoid historical matrix expansion.

Run required checks once on final code and tests with unchanged options.
Make/direct aliases share one result. A through report covers earlier PAs;
run the stage separately only where required. Reuse scripts and receipts.
This supersedes older plan/script checklists; all course gates apply.

Refresh final course acceptance; earlier stages, quality and file audits pass.
No known stage correctness or architecture defect remains. Record one compact
audit/ledger delta with findings, fixes and evidence links.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the goal. Complete the phase with `update_goal` status `complete`
and return a validated handoff. Partial completion ends the turn, not the stage.
Never create/replace goals, edit their state or wait for Ralph-owned checks.
