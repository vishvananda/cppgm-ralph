Ralph loop {{turnNumber}} for {{runName}}.

Review every PA35 change since the reviewed boundary.
- Transform legality, ownership, required reducers/generated controls are checked.
- Measured rung progress is preserved; validation reruns only confirm fixes.
- A canonical group is refreshed only when a fix changed the compiler.
- Attribution separates constant-source codegen from compiler-speed changes.
- Reviewed code tip, findings and evidence deltas are recorded in the compact ledger.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native phase goal. Return a validated handoff, call `update_goal`
with status `complete`, and finish the turn. Partial completion ends a turn,
not the assignment. Never create or replace goals, edit Ralph state, or wait
for Ralph-owned checks.
