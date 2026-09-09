Perform the final audit for `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Read `spec.md`, the assignment README, stage commits, source and plan.
Independently reconstruct the whole-stage architecture; checkpoint conclusions
do not substitute for this review.

Apply the spec's architecture audit to the surfaces available in this PA.
Trace representative data end to end and fix defects across their full ownership
paths. Review fixed compiler and applicable executable benchmarks beyond course
tests: latency, peak memory, runtime and text size. Follow the spec's frozen A/B,
ABBA and noise-calibration protocol for claims; verify optimization legality,
profitability, invalidation and pipeline work/growth budgets. Fewer IR nodes
alone do not establish runtime improvement.

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
