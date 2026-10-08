Perform the final audit for `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Read `spec.md`, the assignment README, stage commits, source and plan.
Independently reconstruct the whole-stage architecture; checkpoint conclusions
do not substitute for this review.

Review stage-due capability families and their interactions with representative
GCC/Clang/reference comparisons; fixture success is a quality floor. Apply the
spec's architecture audit to every surface this PA exercises: cite
the upholding `file:function` for each invariant or fix the violation across its full
ownership path. Verify complete stage-supported fixed compiler/executable
benchmark coverage against final code: same-input hosts, latency, peak memory,
runtime and text/object size. Fill missing or invalidated evidence; reuse valid
unchanged results. Refresh measurements mandated for acceptance. Follow the
spec's frozen A/B counter protocol: repeated instructions/cycles and IPC,
matching affinity, raw observations/spread and valid running percentages.
Profile disproportionate costs and fix their owners before signoff; verify
optimization legality, profitability, invalidation and budgets. Harness timeouts
are not budgets; spec rules hold when tests pass. Only numeric targets from
earlier plans may be reclassified, with evidence; preserve all measurements.

Consolidate the plan and audit: final design/spec alignment, findings, changes,
performance evidence, validation and ledger. Include any unaudited handoffs
remaining since the last checkpoint audit.

Exception to reference preservation: you may correct reference outputs without
approval if a reduced reproducer and cited C++11 rules (LowIR contract for
IR-only cases) prove them wrong. Document the proof and bundle revision;
compiler agreement alone is insufficient. Preserve required behavior, coverage
and comparison rules.

Required exit criteria:
{{modelValidation}}

Commit cohesive refactors and cleanup and leave `git status --short` empty.

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
