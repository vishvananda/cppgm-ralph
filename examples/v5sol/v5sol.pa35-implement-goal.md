Ralph loop {{turnNumber}} for {{runName}}.

Complete a coherent PA35 optimization handoff.
- Legality and architecture hold; earlier behavior and smoke controls pass.
- Changed canonical gate groups are refreshed with current hashes/provenance.
- Saved progress rungs genuinely improve; unchanged valid measurements are reused.
- Constant-work codegen effects and compiler-speed effects are distinguished.
- No full simulation without final acceptance or a stated diagnostic question.
- Complete-stage handoff requires the canonical 17-gate test on final code.
- Compact plan records remaining gates, mechanisms, evidence and handoff boundary.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph creates and schedules the native phase goal. Satisfy this phase, call
`update_goal` with status `complete`, and return a validated handoff. Partial
implementation completion ends this turn, not the assignment. Never create or
replace the goal, edit its state, or wait for Ralph-owned checks.
