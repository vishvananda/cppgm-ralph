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
- Affected benchmarks and the relevant slowest workload have same-input host
  evidence under the spec's counter protocol; valid unchanged results may be
  reused. Expand for broader regressions; profile disproportionate costs.
  Timeouts are not budgets.
- Earlier PAs pass; the latest checkpoint failure count is not exceeded and
  test coverage is not reduced.
- The compact plan and audit record findings, evidence, the reviewed code tip
  as `Last reviewed commit`, and broadly grouped remaining work.
- File audit and required checks pass:
{{modelValidation}}
- Intended changes are committed; `git status --short` is empty.

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
