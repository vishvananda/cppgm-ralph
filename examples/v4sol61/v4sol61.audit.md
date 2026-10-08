Perform the final audit for `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Read `spec.md`, the assignment README, stage commits, source and plan.
Independently reconstruct the whole-stage architecture; checkpoint conclusions
do not substitute for this review.

Review stage-due capability families and their interactions with representative
GCC/Clang/reference comparisons; fixture success is a quality floor. Apply the
spec's architecture audit to every surface this PA exercises: cite
the upholding `file:function` for each invariant or fix the violation across its full
ownership path. Review the stage's slowest tests and the fixed compiler and
executable benchmarks with the host compiler on the same input: latency, peak
memory, runtime and text/object size. Profile anything that is a large multiple
of the host or dominates suite time and fix the owning algorithm before signoff.
Follow the spec's frozen A/B hardware-counter protocol: repeated `perf stat`
instructions/cycles and IPC at matching affinity, with branch/cache counters
as needed and `perf record` attribution. Check counter running percentages,
retain raw observations and report spread; verify
optimization legality, profitability, invalidation and budgets. Harness timeouts
are not budgets; spec rules hold when tests pass. Only numeric targets from
earlier plans may be reclassified, with evidence; preserve all measurements.

Consolidate the plan and audit: final design/spec alignment, findings, changes,
performance evidence, validation and ledger. Include any unaudited handoffs
remaining since the last checkpoint audit.

Exception to reference preservation: you may correct reference outputs without
approval if a reduced reproducer and cited C++11 rules (LowIR contract for
IR-only cases) prove them wrong. Document the proof and bundle revision;
compiler agreement alone is insufficient. Preserve required behavior, coverage
and comparison rules.

Required exit criteria:
{{modelValidation}}

Commit cohesive refactors and cleanup and leave `git status --short` empty.

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
