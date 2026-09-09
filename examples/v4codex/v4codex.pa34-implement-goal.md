Ralph loop {{turnNumber}} PA34 implementation phase for {{runName}}.

Complete PA34 inception as the final reproducibility increment of the compiler.

Completion criteria:
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The real self-hosting path conforms to `spec.md` and preserves PA1-PA33.
- Layer divergences are fixed in the earliest owning compiler surface, with
  focused reducers where applicable.
- Required self, `pptoken` inception, and full inception checks pass without
  self-hosting shortcuts or weakened validation.
- Material divergences are fixed with the spec's compiler latency/memory and
  executable runtime/text-size evidence; optimization budgets are respected.
- File audit and required exit criteria pass:
{{modelValidation}}
- The plan is current, intended changes are committed, and `git status --short`
  is empty.
