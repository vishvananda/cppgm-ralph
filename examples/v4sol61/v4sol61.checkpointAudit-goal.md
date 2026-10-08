Ralph loop {{turnNumber}} checkpoint audit for {{runName}}.

Audit all `{{testStage}}` changes since the last review against `spec.md`.

Completion criteria:
- Final acceptance includes stage-due controls and the PA33/PA34 1.25x GCC
  instruction gate. Partial handoffs preserve inherited controls; reviews assess
  capability coverage beyond fixture success.
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The accumulated range and its interactions comply with current-stage spec and
  correctness rules; every architecture-audit invariant is cited or fixed.
- Performance evidence includes the host compiler on the same input; the slowest
  workload has repeated `perf stat` instructions/cycles and IPC, raw
  observations/spread and `perf record` attribution if disproportionate, under
  the spec's hardware-counter protocol. Timeouts are not budgets.
- Earlier PAs pass; the latest checkpoint failure count is not exceeded and
  test coverage is not reduced.
- The compact plan and audit record findings, evidence, the reviewed code tip
  as `Last reviewed commit`, and broadly grouped remaining work.
- File audit and required checks pass:
{{modelValidation}}
- Intended changes are committed; `git status --short` is empty.

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
