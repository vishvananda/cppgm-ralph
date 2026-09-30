Audit the accumulated implementation for `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- full primary log: `{{lastTestLogPath}}`

Read `spec.md`, the assignment README and `{{testStage}}/plan.md`. Review every
commit and the combined source changes from `Last reviewed commit` through HEAD,
including interactions across handoffs. For the first audit use `Stage base
commit`; if markers are missing, recover the stage boundary from history rather
than narrowing the review to the latest handoff.

Apply the spec's architecture audit and fix affected ownership paths. Verify
compiler latency/memory, applicable runtime/text size, and optimization
legality/profitability/budgets using its evidence protocol. Earlier PAs pass;
latest checkpoint failures must not increase and coverage must not shrink.
Apply the spec's stage-scoped performance acceptance, including to inherited
plans. Reclassify unsupported self-imposed gates with evidence; preserve
measurements, mandated limits, correctness and coverage.

After validating and committing code fixes, record that code tip as `Last
reviewed commit`. Update the compact plan and `{{testStage}}/audit.md` with the
range, findings, evidence and one ledger row. Group remaining work broadly and
note avoidable handoff fragmentation. Commit these records without further code
edits so the next audit has an unambiguous baseline.

Exception to reference preservation: you may correct reference outputs without
approval if a reduced reproducer and cited C++11 rules (LowIR contract for
IR-only cases) prove them wrong. Document the proof and bundle revision;
compiler agreement alone is insufficient. Preserve required behavior, coverage
and comparison rules.

Required exit criteria:
{{modelValidation}}

Commit cohesive audit fixes and leave `git status --short` empty.
