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
ownership, implementing related facts and all their consumers together. Record
owner, data flow, complexity and validation. Continue related fixes while the
same understanding supports progress; a commit or minimum test gain is not a
handoff boundary. An incomplete handoff finishes a coherent behavior group and
explains why further related work is impractical. Fix known correctness and spec
defects; record unfinished work and audit questions without waiving either.
Do not reopen independent architecture investigations merely because further
improvements might exist.

New lookup, overload, template, lowering and codegen paths must satisfy the
spec's architecture invariants at scale from their first version. Validate changed
owners with focused correctness tests, work counters and representative scaling
inputs. Measure affected benchmark families under the spec's protocol; reuse
valid unchanged evidence. Expand measurement for demonstrated regressions,
disproportionate costs or shared infrastructure changes.

Keep `{{testStage}}/plan.md` compact: alignment, remaining groups, evidence links
and a handoff ledger. Record evidence deltas without repeating inherited tables;
consolidate at final audit. Before stage edits, record HEAD as `Stage base commit` and
`Last reviewed commit`; preserve both during implementation.
Historical plans/audits supply evidence; current spec and phase criteria govern.

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

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
