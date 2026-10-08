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
Resolve known correctness and spec defects in that group. Record unfinished
implementation and independent-audit questions separately, waiving neither.

Build for scale, not for the fixture: new lookup, overload, template, lowering
and codegen code must satisfy the spec's architecture-audit invariants on large
hosted translation units from the first version. A stringly or whole-TU-scan
shortcut that passes a small test is a defect to fix now. After touching a hot
path, measure representative stage-supported inputs using the spec's protocol.
Investigate same-source GCC/Clang/reference gaps by capability, not just local edits.

Keep `{{testStage}}/plan.md` compact: design/spec alignment, remaining groups,
performance evidence and a handoff ledger. On first entry, before stage edits,
record HEAD as `Stage base commit` and `Last reviewed commit`; preserve both
during implementation.

Use the spec's repeated counter/timing protocol and stage-due quality controls;
record latency/RSS and executable runtime/size separately. Controls judge
behavior and broad costs, not implementation shape. Qualify new portable cases
with GCC and Clang; unresolved timing is inconclusive. Harness timeouts are
not budgets. Plan for the PA33 per-workload 1.25x GCC instruction limit before
PA24/26 representation choices; the limit remains mandatory through PA34.
Only prior-plan numeric targets may be reclassified with evidence.

At handoff, earlier PAs and file audit pass; current failures decrease or reach
zero without reduced coverage. Adding passing tests alone is not progress.
Refresh the plan, leave committed, clean changes and return a final
implementation handoff to Ralph. This returns control to Ralph without certifying the
assignment; Ralph audits every third incomplete handoff and the passing stage.

Exception to reference preservation: you may correct reference outputs without
approval if a reduced reproducer and cited C++11 rules (LowIR contract for
IR-only cases) prove them wrong. Document the proof and bundle revision;
compiler agreement alone is insufficient. Preserve required behavior, coverage
and comparison rules.

Required exit criteria:
{{modelValidation}}

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
