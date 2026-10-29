Ralph loop {{turnNumber}} for {{runName}}.

Complete ONE coherent PA35 optimization batch, not the whole assignment.
- Legality and architecture hold; earlier behavior and smoke controls pass.
- The changed canonical group is refreshed once on the final tree; other groups
  keep their cached results. Saved-rung failures decrease from turn start
  without losing coverage; remaining failed gates permit a batch handoff.
- `ab.pl` attributes the codegen effect; no extra compiler-work or timing
  measurement unless results disagree. Validation ran once after stabilization.
- Only a claim that PA35 is complete requires all 17 canonical gates to pass.
- Compact plan records remaining gates, the mechanism ledger (excess, owner
  model, batch or restructure), evidence and handoff boundary.

Pre-turn check results below identify repair work. Ralph reruns its checks
after handoff; their old BLOCKER labels are not additional completion criteria.
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native `/goal`. Return a validated handoff; its completion check
ends this turn. A validated improving batch satisfies this goal. Never clear
or replace the goal, edit Ralph state, or wait for Ralph-owned checks.
