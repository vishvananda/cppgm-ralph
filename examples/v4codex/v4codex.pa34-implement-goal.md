Ralph loop {{turnNumber}} PA34 implementation phase for {{runName}}.

Complete PA34 inception as the final reproducibility increment of the compiler.

Completion criteria:
- The real self-hosting path conforms to `spec.md` and preserves PA1-PA33.
- Layer divergences are fixed in the earliest owning compiler surface, with
  focused reducers where applicable.
- Required self, `pptoken` inception, and full inception checks pass without
  self-hosting shortcuts or weakened validation.
- Material performance or memory divergence has comparative evidence and its
  root cause is fixed.
- File audit and required exit criteria pass:
{{modelValidation}}
- The plan is current, intended changes are committed, and `git status --short`
  is empty.
