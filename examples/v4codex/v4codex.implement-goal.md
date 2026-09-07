Ralph loop {{turnNumber}} implementation checkpoint for {{runName}}.

Implement `{{testStage}}` as the next coherent, performance-conscious increment
of the existing compiler.

Completion criteria:
- The compact plan defines a substantial checkpoint and identifies its relevant
  `spec.md` requirements, ownership, complexity, and validation.
- The checkpoint implements real compiler behavior consistent with the
  current-stage portions of `spec.md`; material performance risks have evidence.
- Assignments through the previous PA pass.
- The current PA fully passes, or its failure count is lower than the turn-start
  baseline without reducing test coverage. Adding passing tests while retaining
  every existing failure does not count as checkpoint progress.
- File audit and required exit criteria pass:
{{modelValidation}}
- The plan and completed-checkpoint ledger are refreshed.
- Intended changes are committed and `git status --short` is empty.
