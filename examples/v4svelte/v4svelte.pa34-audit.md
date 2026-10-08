Audit PA34 inception.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Review `spec.md`, `pa34/plan.md`, `pa34/README.md`, `pa34/Makefile`,
`dev/frontend_source_sets.mk`, stage commits, changed source, and new reducers.
Create or refresh `pa34/audit.md` with the audit plan.

Perform an independent review using the `spec.md` architecture audit, citing
the upholding `file:function` for each invariant or fixing it, plus PA34's
reproducibility concerns. Verify PA1-PA33, both inception compares, stable
source ownership, deterministic outputs, and correct placement of every reducer.
Trace any PA34-only success path, layer divergence, shortcut, skipped work,
unstable output, timeout/OOM workaround, or weakened check to its owning cause
and fix it. Follow the spec's frozen A/B hardware-counter protocol on fixed
benchmarks: repeated `perf stat` instructions/cycles and IPC, matching affinity,
raw observations and spread, plus `perf record` attribution; check counter
running percentages and use separate branch/cache passes as needed. Report host, seed and self on the same compiler translation
units and full-tree selfhost/inception totals at equal parallelism; profile any
compile that is a large multiple of the host and fix the owning algorithm.
Verify optimization legality, profitability, invalidation and budgets.
Verify complete final-code evidence, reusing valid unchanged results and filling
gaps. Refresh canonical final gates, including the inherited per-workload 1.25x
GCC limit. Recheck controls and unresolved backend capability families.
Harness timeouts are not budgets; only prior-plan numeric targets may be reclassified with evidence.

Update `pa34/plan.md` with Architecture Review and Final Architecture Review,
and consolidate `pa34/audit.md` into Findings, Changes, Performance Evidence,
and Validation.

Exception to reference preservation: you may correct reference outputs without
approval if a reduced reproducer and cited C++11 rules (LowIR contract for
IR-only cases) prove them wrong. Document the proof and bundle revision;
compiler agreement alone is insufficient. Preserve required behavior, coverage
and comparison rules.

Required exit criteria:
{{modelValidation}}

Commit cohesive cleanup and leave `git status --short` empty.

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
