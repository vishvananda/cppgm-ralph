Implement PA34 inception.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Before editing, read `AGENTS.md`, `TESTING_AND_REFERENCES.md`, `spec.md`,
`pa34/README.md`, `pa34/Makefile`, and `dev/frontend_source_sets.mk`. Keep
`pa34/plan.md` focused on the first failing checkpoint, its relevant spec
requirements, the underlying earlier compiler surface, and validation.

PA34 adds no language feature or compiler mode. It proves that the existing
compiler can rebuild itself reproducibly while retaining the architecture in
`spec.md`. Treat failures as earlier compiler or reproducibility bugs.

If host-seeded `../dev/cppgm++` and a `*-self` compiler differ on the same
command, first assume the self compiler may have been miscompiled. Compare their
behavior and trace the divergence back to the self-built object, source, and
earlier compiler feature that produced it. A stack inside `*-self` identifies
where the bad program failed, not necessarily where the compiler fix belongs.

A self-only timeout, OOM, unbounded memory growth, or slowdown beyond roughly
5x on the same source is also divergence evidence. Use the observability and
audit requirements in `spec.md` to distinguish expected local code-quality
differences from a changed branch, call, overload, loop, recursion, allocation,
or repeated-work path. Establish that divergence before changing valid compiler
source merely to avoid a construct that self compilation mishandles.

Implementation checkpoints:
- Keep `make test-report-through-pa33` passing.
- Debug the self ladder with
  `make -C pa34 test-through-pa5 CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++`.
- Use `probe-self-object` and `probe-self-link` for scratch tracing or a
  suspected one-object fix without rebuilding the host compiler. Probe results
  are diagnostic; canonical targets remain required.
- Pass `make -C pa34 compare-pptoken-inception CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++`
  before the full compiler compare.
- Final success requires
  `make inception CXX=g++ CPPGM_HOST_CXX=g++`.
- Reduce compiler bugs into focused tests under the earliest owning
  `student.tests/paN` directory and run them explicitly.

The self-contained implementation and architecture requirements in `spec.md`
remain hard blockers throughout PA34.

Required exit criteria:
{{modelValidation}}

Treat file-audit findings as design blockers. Commit cohesive progress and
leave `git status --short` empty.
