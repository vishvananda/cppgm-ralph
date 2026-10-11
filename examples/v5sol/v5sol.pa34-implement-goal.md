Ralph loop {{turnNumber}} for {{runName}}.

Complete a validated PA34 inception handoff.
- Owning causes of seed/self divergence are fixed with general compiler logic.
- Host regressions, self-test ladder, pptoken compare and canonical inception pass.
- Flags, linking and production paths are consistent; focused evidence is valid.
- The compact plan records ownership and remaining review questions.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph creates and schedules the native phase goal. Satisfy this phase, call
`update_goal` with status `complete`, and return a validated handoff. Partial
implementation completion ends this turn, not the assignment. Never create or
replace the goal, edit its state, or wait for Ralph-owned checks.
