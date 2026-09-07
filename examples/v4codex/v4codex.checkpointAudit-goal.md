Ralph loop {{turnNumber}} checkpoint audit for {{runName}}.

Audit the latest `{{testStage}}` checkpoint against `spec.md` before
implementation continues.

Completion criteria:
- The current checkpoint review and audit-ledger row are updated.
- Earlier assignments pass, the checkpoint failure count is not exceeded, and
  test coverage is not reduced.
- The affected ownership path has no unresolved relevant spec, correctness,
  performance, shortcut, timeout, or file-audit issue.
- Material performance conclusions have representative evidence.
- File audit and required exit criteria pass:
{{modelValidation}}
- The compact plan records current Spec Alignment and the next checkpoint.
- Intended changes are committed and `git status --short` is empty.
