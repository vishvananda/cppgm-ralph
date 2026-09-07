Implement `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- full primary log: `{{lastTestLogPath}}`

Read `AGENTS.md`, `TESTING_AND_REFERENCES.md`, `spec.md`, the assignment README,
and relevant tests. Apply current-stage spec requirements while preserving the
later design. Keep personal tests in `student.tests/` and run them explicitly;
`tests/regression/` fixtures are outside the course exit criteria.

Work toward completing the assignment. Group failures by shared semantic
ownership; record owner, data flow, complexity and validation, then implement
related groups together. Extend the initial scope while the same understanding
supports further fixes. Commit coherent increments throughout the turn.
The initial plan, a commit or minimum test progress is not a stopping boundary.
An incomplete handoff must finish a coherent behavior group and explain the
concrete boundary making further related work impractical.

Keep `{{testStage}}/plan.md` compact: design/spec alignment, remaining groups,
performance evidence and a handoff ledger. On first entry, before stage edits,
record HEAD as `Stage base commit` and `Last reviewed commit`; preserve both
during implementation.

Follow the spec's evidence protocol for performance claims. Measure compiler
latency/peak RSS and, where executable output exists, runtime/text size; optimization
benefits must justify compiler work and growth within explicit budgets.

At handoff, earlier PAs and file audit pass; current failures decrease or reach
zero without reduced coverage. Adding passing tests alone is not progress.
Refresh the plan and leave committed, clean changes. Ralph audits every three
accepted incomplete handoffs and performs a full audit when the stage passes.

Required exit criteria:
{{modelValidation}}
