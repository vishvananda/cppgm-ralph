Ralph loop {{turnNumber}} final audit for {{runName}}.

Independently audit and consolidate completed `{{testStage}}` against `spec.md`
before advancing.

Completion criteria:
- Final acceptance includes stage-due controls and the PA33/PA34 1.25x GCC
  instruction gate. Partial handoffs preserve inherited controls; reviews assess
  capability coverage beyond fixture success.
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- Each architecture-audit invariant is cited in code or its violation is fixed.
- Whole-stage defects are fixed; performance evidence includes the host compiler
  on the same input with repeated `perf stat` instructions/cycles and IPC,
  raw observations/spread and `perf record` attribution of any disproportionate
  workload under the spec's hardware-counter protocol. Harness
  timeouts are not budgets; only prior-plan numeric targets may be reclassified.
- Earlier assignments remain passing and no correctness, self-containment,
  timeout, file-audit or architecture defect remains.
- The compact plan and audit record final Spec Alignment, findings, changes,
  performance evidence, and validation.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed and `git status --short` is empty.

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
