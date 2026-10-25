Build the compiler in safe Rust from the student handouts and fixtures.
Use supplied reference binaries only for their documented course roles.
Do not consult another implementation or require clone-style byte identity.

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

Apply the spec from the first supported version. Validate affected correctness,
required reuse and bounded work; reuse valid qualified evidence under section
11. Investigate demonstrated excess, including repeated linear work, without
expanding unrelated checks. PA34/PA35 are deferred; spec section 7's
code-quality properties still apply from the first backend owner.

Run required checks once on final code and tests with unchanged options.
Make/direct aliases share one result. A through report covers earlier PAs;
run the stage separately only where required. Reuse scripts and receipts.
This supersedes older plan/script checklists; all course gates apply.

Before editing, record HEAD as `Stage base commit` and `Last reviewed commit`.
Keep one compact plan/ledger delta with decisions, remaining groups and evidence
links. Earlier PAs, quality and file audits pass; failures decrease at unchanged
coverage. Finish a coherent group before partial handoff and explain why related
work cannot continue. Ralph reviews every third incomplete handoff and audits
a passing stage.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the goal. Complete the phase with `update_goal` status `complete`
and return a validated handoff. Partial completion ends the turn, not the stage.
Never create/replace goals, edit their state or wait for Ralph-owned checks.
