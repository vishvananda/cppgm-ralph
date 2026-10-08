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
- Whole-stage defects are fixed; complete stage-supported performance evidence
  applies to final code under the spec's counter protocol, with same-input hosts
  and disproportionate-cost attribution. Fill evidence gaps, reuse valid results
  and refresh mandated acceptance measurements. Timeouts are not budgets;
  only prior-plan numeric targets may be reclassified.
- Earlier assignments remain passing and no correctness, self-containment,
  timeout, file-audit or architecture defect remains.
- The compact plan and audit record final Spec Alignment, findings, changes,
  performance evidence, and validation.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed and `git status --short` is empty.

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
