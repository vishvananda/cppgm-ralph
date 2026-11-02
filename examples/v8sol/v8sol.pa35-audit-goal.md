Ralph loop {{turnNumber}} for {{runName}}.

Independently close PA35 on final code.
- All 17 unmodified course gates, through-PA33 and canonical inception pass.
- Architecture, correctness, transformation budgets and self-compilation are reviewed.
- Workload, flags, allocator, link lines and protocols are preserved.
- Generated-seed coverage and constant-work attribution support the changes.
- Final evidence is valid; exploratory counts/progress summaries waive no gate.
- Compact plan/audit record alignment, changes, owner attribution and validation.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native phase goal. Return a validated handoff, call `update_goal`
with status `complete`, and finish the turn. Partial completion ends a turn,
not the assignment. Never create or replace goals, edit Ralph state, or wait
for Ralph-owned checks.
