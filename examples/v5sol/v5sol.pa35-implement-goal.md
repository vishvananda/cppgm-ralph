Ralph loop {{turnNumber}} for {{runName}}.

Complete a coherent PA35 optimization handoff.
- Legality and architecture hold; earlier behavior and smoke controls pass.
- The changed canonical group is refreshed once on the final tree; other groups
  keep their cached results. Saved progress rungs genuinely improve.
- `ab.pl` attributes the codegen effect; no extra compiler-work or timing
  measurement unless results disagree. Validation ran once after stabilization.
- Complete-stage handoff requires the canonical 17-gate test on final code.
- Compact plan records remaining gates, the mechanism ledger (excess, owner
  model, batch or restructure), evidence and handoff boundary.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph creates and schedules the native phase goal. Satisfy this phase, call
`update_goal` with status `complete`, and return a validated handoff. Partial
implementation completion ends this turn, not the assignment. Never create or
replace the goal, edit its state, or wait for Ralph-owned checks.
