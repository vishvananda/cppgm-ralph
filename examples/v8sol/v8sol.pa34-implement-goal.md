Ralph loop {{turnNumber}} for {{runName}}.

Complete a validated PA34 inception handoff.
- Owning causes of seed/self divergence are fixed with general compiler logic.
- Host regressions, self-test ladder, pptoken compare and canonical inception pass.
- Flags, linking and production paths are consistent; focused evidence is valid.
- The compact plan records ownership and remaining review questions.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native phase goal. Return a validated handoff, call `update_goal`
with status `complete`, and finish the turn. Partial completion ends a turn,
not the assignment. Never create or replace goals, edit Ralph state, or wait
for Ralph-owned checks.
