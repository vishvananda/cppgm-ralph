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
- Material divergences are fixed; performance evidence covers host, seed and
  self on the same inputs using repeated `perf stat` instructions/cycles and
  IPC under the spec's protocol, with `perf record` attribution of disproportionate
  workloads. Timeouts are not treated as budgets.
- File audit and required exit criteria pass:
{{modelValidation}}
- The plan is current, intended changes are committed, and `git status --short`
  is empty.

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
