Ralph loop {{turnNumber}} final audit for {{runName}}.

Independently audit and consolidate completed `{{testStage}}` against `spec.md`
before advancing.

Completion criteria:
- The actual stage architecture and representative data flow are reviewed
  against the relevant spec requirements.
- Whole-stage architecture and performance issues are fixed across their full
  ownership path, with representative performance evidence.
- Earlier assignments remain passing and no correctness, self-containment,
  timeout, file-audit, architecture, or performance issue remains.
- The compact plan and audit record final Spec Alignment, findings, changes,
  performance evidence, and validation.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed and `git status --short` is empty.
