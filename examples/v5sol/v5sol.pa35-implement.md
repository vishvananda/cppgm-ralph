Implement PA35 compiler optimization.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Read `pa35/README.md`, `gates.txt`, Makefile and the relevant supplied
scripts, plus the root instructions/spec. Use their protocols and unchanged
workload. Work in the prescribed order: correctness/workload support, compiler
speed and scaling, codegen, then speed changes preserving generated output.
A performance limit is a floor, not a reason to specialize for its fixtures.

Freeze once per batch; iterate with cached `quick` and constant-source `ab.pl`
(counts, no simulation), `identity` for speed-only claims, `speed`/`scaling` or
a bounded profile for compiler-speed excess. After the batch stabilizes run each
validation once on the final tree: smoke, the generated-seed check when the
allocator or MIR changed, inception when emission changed, then the changed
canonical group, the batch's one simulation. Ralph repeats the required checks;
do not pre-run them more than once. Timing confirms milestones, not handoffs; a
difference inside A/A noise is no finding. Keep allocators and build/link lines
equal.

Each handoff is one coherent batch against the largest excess mechanism of one
owner and requires genuine progress in the canonical saved gate-group
measurements. Refresh the affected group before `test-progress`; it only reads
rungs and cannot certify changed code. Unchanged groups keep their cached
results; never manufacture progress by editing results or timestamps. Keep a
mechanism ledger in the plan: remaining excess by class,
its owning model, and whether the fix is a batch or a restructure. When a change
loses on A/B because of another owner's model, or needs that model replaced,
record it there for the scheduled restructure turn rather than reverting it
silently or tuning thresholds. Preserve earlier through-PA33 behavior and run
inception regularly. Complete implementation only after canonical
`make -C pa35 test` passes on the final tree; the independent audit still
remains. Do not rebuild measurement infrastructure already supplied by the
assignment.

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
