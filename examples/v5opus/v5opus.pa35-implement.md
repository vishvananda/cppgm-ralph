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

Use cached `quick`, a focused gate group, and `test-smoke` during iteration.
Diagnose excess with `speed`, `scaling` or a bounded profile; full cache
simulation requires final acceptance or a stated unresolved question. Freeze
before an optimizer change and use constant-source `ab.pl` to attribute codegen;
use `identity` for speed-only claims. Keep allocators and build/link lines equal.
Follow the handout's generated-seed checks for allocator/MIR changes.

A partial handoff requires genuine progress in the canonical saved gate-group
measurements. Refresh the affected group before `test-progress`; it only reads
rungs and cannot certify changed code. Record current binary/source/protocol
hashes and valid provenance for unchanged groups. Never manufacture progress by
editing results or timestamps. Preserve earlier through-PA33 behavior, run
inception regularly, and keep the plan/evidence ledger compact.
Complete implementation only after canonical `make -C pa35 test` passes on the
final tree; the independent audit still remains. Do not rebuild measurement
infrastructure already supplied by the assignment.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native `/goal`. Return a validated handoff; its completion check
ends the phase. Partial completion ends a turn, not the assignment. Never clear
or replace the goal, edit Ralph state, or wait for Ralph-owned checks.
