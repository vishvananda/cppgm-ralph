Ralph loop {{turnNumber}} for {{runName}}.

Independently close completed `{{testStage}}`.
- Required capability interactions and supported architecture are reviewed in code.
- Known stage defects are fixed; canonical course acceptance passes on final code.
- Missing/invalidated focused evidence is filled; unchanged results are reused.
- Plan/audit consolidate alignment, findings, evidence, validation and ledger.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph creates and schedules the native phase goal. Satisfy this phase, call
`update_goal` with status `complete`, and return a validated handoff. Partial
implementation completion ends this turn, not the assignment. Never create or
replace the goal, edit its state, or wait for Ralph-owned checks.
