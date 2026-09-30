Ralph loop {{turnNumber}} implementation for {{runName}}.

Complete a validated implementation handoff for `{{testStage}}`, extending
related behavior groups while the same understanding supports further progress.
This goal ends the implementation turn, not the assignment's independent audit.

Completion criteria:
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The completed behavior group satisfies current-stage `spec.md`, including
  correctness, architecture and stage-scoped performance acceptance/evidence.
- Any incomplete handoff finishes a coherent behavior group and justifies why
  further related work is impractical; meeting the progress minimum is not enough.
- Earlier PAs pass; current failures decrease or reach zero without reduced
  coverage. Adding passing tests alone does not qualify.
- The compact plan and ledger distinguish unfinished implementation from
  independent review questions; neither is waived. Record the handoff boundary
  and preserve review markers.
- File audit and required checks pass:
{{modelValidation}}
- Intended changes are committed; `git status --short` is empty.

When these criteria are met, finish the turn with a concise handoff, even if
the assignment remains incomplete. Ralph verifies the handoff and schedules
further implementation or audit; audit must resolve whole-stage findings
before advancement.
