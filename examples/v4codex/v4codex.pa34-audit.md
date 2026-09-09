Audit PA34 inception.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Review `spec.md`, `pa34/plan.md`, `pa34/README.md`, `pa34/Makefile`,
`dev/frontend_source_sets.mk`, stage commits, changed source, and new reducers.
Create or refresh `pa34/audit.md` with the audit plan.

Perform an independent review using the `spec.md` architecture audit
plus PA34's reproducibility concerns. Verify PA1-PA33, both inception compares,
stable source ownership, deterministic outputs, and correct placement of every
reducer. Trace any PA34-only success path, layer divergence, shortcut, skipped
work, unstable output, timeout/OOM workaround, or weakened check to its owning
cause and fix it. Follow the spec's frozen A/B, ABBA and noise-calibration
protocol on fixed benchmarks. Compare host-seeded and self-built compiler
latency/memory and generated runtime/text size; verify optimization legality,
profitability, invalidation and pipeline work/growth budgets.

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
