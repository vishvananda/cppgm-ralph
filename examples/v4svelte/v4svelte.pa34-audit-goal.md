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
  hardware-counter protocol. Reuse valid results, fill gaps and refresh mandated
  acceptance measurements. Timeouts are not budgets.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed and `git status --short` is empty.

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
