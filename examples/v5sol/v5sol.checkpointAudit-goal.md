Ralph loop {{turnNumber}} for {{runName}}.

Review all accumulated `{{testStage}}` changes since the reviewed boundary.
- Supported architecture, interactions and required reuse are checked; violations fixed.
- Checkpoint progress is preserved; affected controls pass with scoped evidence.
- Valid results are reused and uncertainty is distinguished from demonstrated defects.
- The reviewed code tip, findings and ledger are recorded without subsequent code edits.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph creates and schedules the native phase goal. Satisfy this phase, call
`update_goal` with status `complete`, and return a validated handoff. Partial
implementation completion ends this turn, not the assignment. Never create or
replace the goal, edit its state, or wait for Ralph-owned checks.
