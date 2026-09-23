Ralph loop {{turnNumber}} final audit for {{runName}}.

Independently audit and consolidate completed `{{testStage}}` against `spec.md`
before advancing.

Completion criteria:
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The actual stage architecture and representative data flow are reviewed
  against the relevant spec requirements.
- Whole-stage defects are fixed; performance meets the spec's stage-scoped
  acceptance and evidence rules, not self-imposed exit gates.
- Earlier assignments remain passing and no correctness, self-containment,
  timeout, file-audit or architecture defect remains.
- The compact plan and audit record final Spec Alignment, findings, changes,
  performance evidence, and validation.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed and `git status --short` is empty.
