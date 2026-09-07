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

After validating and committing code fixes, record that code tip as `Last
reviewed commit`. Update the compact plan and `{{testStage}}/audit.md` with the
range, findings, evidence and one ledger row. Group remaining work broadly and
note avoidable handoff fragmentation. Commit these records without further code
edits so the next audit has an unambiguous baseline.

Required exit criteria:
{{modelValidation}}

Commit cohesive audit fixes and leave `git status --short` empty.
