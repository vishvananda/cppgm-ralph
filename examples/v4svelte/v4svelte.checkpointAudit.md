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

Review stage-due families and their interactions with representative
GCC/Clang/reference comparisons; fixtures are a quality floor. Apply the spec's
architecture audit across changed ownership paths: cite each invariant's
upholding `file:function` or fix it. Refresh affected fixed benchmarks and the
relevant slowest workload under the hardware-counter protocol, including
same-input hosts, instructions/cycles, IPC, raw observations and spread. Reuse
valid unchanged evidence; expand the matrix for shared changes or broader
regressions. Profile disproportionate costs and fix their owners; being the
slowest alone does not establish a defect. Earlier PAs pass; checkpoint failures
and coverage are preserved. Timeouts are not budgets. Only prior-plan numeric
targets may be reclassified.

After validating and committing code fixes, record that code tip as `Last
reviewed commit`. Update the compact plan and `{{testStage}}/audit.md` with the
range, findings, evidence deltas/links and one ledger row. Group remaining work
broadly and note avoidable handoff fragmentation. Commit these records without further code
edits so the next audit has an unambiguous baseline.

Exception to reference preservation: you may correct reference outputs without
approval if a reduced reproducer and cited C++11 rules (LowIR contract for
IR-only cases) prove them wrong. Document the proof and bundle revision;
compiler agreement alone is insufficient. Preserve required behavior, coverage
and comparison rules.

Required exit criteria:
{{modelValidation}}

Commit cohesive audit fixes and leave `git status --short` empty.

Native goals: Ralph creates the phase goal. Satisfy its objective and phase
instructions, call `update_goal` with status `complete`, then return a concise
validated handoff. An implementation goal ends the turn; unfinished assignment
work and independent audits remain. Ralph verifies the goal and external checks
before advancing. Never create or replace the goal or edit its state; hand off
without waiting for Ralph-owned gates.
