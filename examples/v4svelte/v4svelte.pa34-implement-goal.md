Ralph loop {{turnNumber}} PA34 implementation phase for {{runName}}.

Complete PA34 inception as the final reproducibility increment of the compiler.

Completion criteria:
- Inherited controls and the 1.25x GCC instruction gate pass; runtime gaps have
  same-source evidence and a capability review. Inception proves reproducibility,
  not speed.
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The real self-hosting path conforms to `spec.md` and preserves PA1-PA33.
- Layer divergences are fixed in the earliest owning compiler surface, with
  focused reducers where applicable.
- Required self, `pptoken` inception, and full inception checks pass without
  self-hosting shortcuts or weakened validation.
- Material divergences are fixed; affected host/seed/self comparisons follow
  the spec's counter protocol, reusing valid unchanged evidence and profiling
  disproportionate costs. Canonical acceptance gates remain mandatory;
  timeouts are not budgets.
- File audit and required exit criteria pass:
{{modelValidation}}
- The plan is current, intended changes are committed, and `git status --short`
  is empty.

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
