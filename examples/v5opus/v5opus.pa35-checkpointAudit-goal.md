Ralph loop {{turnNumber}} for {{runName}}.

Review every PA35 change since the reviewed boundary.
- Transform legality, ownership, required reducers/generated controls are checked.
- Measured rung progress is preserved; current/unchanged evidence has valid provenance.
- Invalidate only affected groups; do not replace acceptance with quick counts.
- Attribution separates constant-source codegen from compiler-speed changes.
- Reviewed code tip, findings and evidence deltas are recorded in the compact ledger.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native `/goal`. Return a validated handoff; its completion check
ends the phase. Partial completion ends a turn, not the assignment. Never clear
or replace the goal, edit Ralph state, or wait for Ralph-owned checks.
