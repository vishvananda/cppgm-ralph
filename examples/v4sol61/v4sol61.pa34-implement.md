Implement PA34 inception.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Before editing, read `AGENTS.md`, `TESTING_AND_REFERENCES.md`, `spec.md`,
`pa34/README.md`, `pa34/Makefile`, and `dev/frontend_source_sets.mk`. Keep
`pa34/plan.md` compact with remaining divergences, their owning compiler
surfaces, spec requirements and validation. Continue through related fixes;
passing a ladder rung or committing a fix is not a handoff boundary.

PA34 proves reproducible self-compilation and adds no language feature or mode.
Treat failures as earlier compiler or reproducibility bugs.

If seed and self-built compilers differ on the same command, investigate
miscompilation: trace the divergence to its object, source and owning compiler
feature. The failing self-built stack may only show the symptom.

A self-only timeout, OOM or material slowdown is also divergence evidence.
Use the spec's hardware-counter protocol (`perf stat` instructions/cycles and
IPC, with `perf record` attribution) to separate code-quality differences from
miscompilation or repeated work before changing valid compiler source to avoid
a construct. Report host, seed and self on the same compiler translation units
and full-tree selfhost/inception totals at equal parallelism; a seed that is a
large multiple of the host is a frontend defect to profile and fix, not a
baseline to normalize against.

Use frozen-workload seed/self comparisons for focused iteration and retain the
canonical final gates, including the inherited per-workload 1.25x GCC instruction
limit. Recheck quality controls and unresolved backend capability families.
Harness timeouts are not budgets; only prior-plan numeric targets may be reclassified with evidence.

Follow the required host regression, self-test ladder, pptoken inception and
full inception checks below, in order. `probe-self-object` and `probe-self-link`
are diagnostic only; finish with canonical builds. Put reducers under the
earliest owning `student.tests/paN` and run them explicitly.

Exception to reference preservation: you may correct reference outputs without
approval if a reduced reproducer and cited C++11 rules (LowIR contract for
IR-only cases) prove them wrong. Document the proof and bundle revision;
compiler agreement alone is insufficient. Preserve required behavior, coverage
and comparison rules.

Required exit criteria:
{{modelValidation}}

Preserve self-containment and file-audit requirements. Commit cohesive progress
and leave `git status --short` empty.

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
