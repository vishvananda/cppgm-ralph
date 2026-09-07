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
Use the spec's measurement protocol to separate code-quality differences from
miscompilation or repeated work before changing valid compiler source to avoid
a construct. Compare compiler latency/memory and generated runtime/text size;
runtime gains must justify optimization work and growth within explicit budgets.

Follow the required host regression, self-test ladder, pptoken inception and
full inception checks below, in order. `probe-self-object` and `probe-self-link`
are diagnostic only; finish with canonical builds. Put reducers under the
earliest owning `student.tests/paN` and run them explicitly.

Required exit criteria:
{{modelValidation}}

Preserve self-containment and file-audit requirements. Commit cohesive progress
and leave `git status --short` empty.
