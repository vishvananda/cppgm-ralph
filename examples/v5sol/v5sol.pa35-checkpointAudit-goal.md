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

Ralph creates and schedules the native phase goal. Satisfy this phase, call
`update_goal` with status `complete`, and return a validated handoff. Partial
implementation completion ends this turn, not the assignment. Never create or
replace the goal, edit its state, or wait for Ralph-owned checks.
