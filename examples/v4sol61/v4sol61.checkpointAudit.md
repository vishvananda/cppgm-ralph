Audit the accumulated implementation for `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- full primary log: `{{lastTestLogPath}}`

Read `spec.md`, the assignment README and `{{testStage}}/plan.md`. Review every
commit and the combined source changes from `Last reviewed commit` through HEAD,
including interactions across handoffs. For the first audit use `Stage base
commit`; if markers are missing, recover the stage boundary from history rather
than narrowing the review to the latest handoff.

Review stage-due capability families and their interactions with representative
GCC/Clang/reference comparisons; fixture success is a quality floor. Apply the
spec's architecture audit to the changed ownership paths: cite the
upholding `file:function` for each invariant or fix the violation. Measure the stage's
slowest test and fixed benchmarks with the host compiler on the same input
using repeated `perf stat` instructions/cycles and IPC under the spec's
hardware-counter protocol; retain raw observations and spread. Use `perf record`
to profile anything that is a large multiple of the host or dominates suite time
and fix the owning algorithm. Harness timeouts are not budgets; spec rules hold
when tests pass. Earlier PAs pass; checkpoint failures must not increase and
coverage must not shrink. Only prior-plan numeric targets may be reclassified.

After validating and committing code fixes, record that code tip as `Last
reviewed commit`. Update the compact plan and `{{testStage}}/audit.md` with the
range, findings, evidence and one ledger row. Group remaining work broadly and
note avoidable handoff fragmentation. Commit these records without further code
edits so the next audit has an unambiguous baseline.

Exception to reference preservation: you may correct reference outputs without
approval if a reduced reproducer and cited C++11 rules (LowIR contract for
IR-only cases) prove them wrong. Document the proof and bundle revision;
compiler agreement alone is insufficient. Preserve required behavior, coverage
and comparison rules.

Required exit criteria:
{{modelValidation}}

Commit cohesive audit fixes and leave `git status --short` empty.

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
