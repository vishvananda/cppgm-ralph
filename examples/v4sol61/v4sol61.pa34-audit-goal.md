Ralph loop {{turnNumber}} PA34 audit phase for {{runName}}.

Audit PA34 inception against `spec.md` before completing the run.

Completion criteria:
- Inherited controls and the 1.25x GCC instruction gate pass; runtime gaps have
  same-source evidence and a capability review. Inception proves reproducibility,
  not speed.
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The final implementation and both inception layers satisfy the spec's
  architecture (each invariant cited or fixed), stage-scoped performance,
  observability and self-containment requirements.
- PA1-PA33 and all required PA34 checks pass reproducibly.
- No layer divergence, PA34-only path, shortcut, nondeterminism, missing
  reducer, timeout/OOM workaround, or file-audit issue remains.
- The plan and audit record final architecture, optimization budgets and
  host/seed/self compiler latency/memory and executable runtime/text-size
  evidence across generations, plus repeated `perf stat` instructions/cycles
  and IPC, raw observations/spread and `perf record` attribution under the spec's
  hardware-counter protocol. Timeouts are not budgets.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed and `git status --short` is empty.

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
