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

Trace affected results through producers and consumers: show reused and new
work. Proportional growth alone does not establish efficient reuse. Under spec
section 11, reuse valid evidence. Preserve stage progress and earlier PAs.

Run required checks once on final code and tests with unchanged options.
Make/direct aliases share one result. A through report covers earlier PAs;
run the stage separately only where required. Reuse scripts and receipts.
This supersedes older plan/script checklists; all course gates apply.

After validation set `Last reviewed commit` to the reviewed tip. Record one
compact audit/ledger delta; link evidence. Keep unfinished work and uncertainty
explicit.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the goal. Complete the phase with `update_goal` status `complete`
and return a validated handoff. Partial completion ends the turn, not the stage.
Never create/replace goals, edit their state or wait for Ralph-owned checks.
