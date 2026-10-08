Ralph loop {{turnNumber}} implementation for {{runName}}.

Complete a validated implementation handoff for `{{testStage}}`, extending
related behavior groups while the same understanding supports further progress.
This goal ends the implementation turn, not the assignment's independent audit.

Completion criteria:
- Final acceptance includes stage-due controls and the PA33/PA34 1.25x GCC
  instruction gate. Partial handoffs preserve inherited controls; reviews assess
  capability coverage beyond fixture success.
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The completed group satisfies current-stage correctness and architecture
  requirements, with focused scaling and affected host-relative performance
  evidence under the spec's protocol; valid unchanged evidence may be reused.
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

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
