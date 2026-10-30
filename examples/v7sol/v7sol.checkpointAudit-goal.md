Ralph loop {{turnNumber}} for {{runName}}.

Review all accumulated `{{testStage}}` changes since the reviewed boundary.
- Supported architecture, compact storage, interactions and reuse are checked; violations fixed.
- Checkpoint progress is preserved; affected controls pass with scoped evidence.
- Valid results are reused and uncertainty is distinguished from demonstrated defects.
- The reviewed code tip, findings and ledger are recorded without subsequent code edits.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native phase goal. Return a validated handoff, call `update_goal`
with status `complete`, and finish the turn. Partial completion ends a turn,
not the assignment. Never create or replace goals, edit Ralph state, or wait
for Ralph-owned checks.
