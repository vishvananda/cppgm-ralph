Audit PA39 inception.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Review `pa39/plan.md`, `pa39/README.md`, `pa39/Makefile`,
`dev/frontend_source_sets.mk`, recent commits, changed source files, and any
new `cppgm.tests/course/paN` reducers. Before making audit changes, create or
update `pa39/audit.md` with an `Audit Plan` naming the checkpoints, ownership
boundaries, reproducibility risks, performance risks, and file-audit issues you
will inspect.

Audit for:
- regressions against PA1 through PA38;
- PA39-only success paths or self-hosting special cases;
- generated source-set scans replacing `dev/frontend_source_sets.mk`;
- dummy output, embedded payload, interpreter/VM/trampoline/template-binary, or
  copied-runtime substitutes;
- fixture gates, timeout workarounds, weakened harnesses, or skipped checks;
- reproducibility hazards such as unstable output order, embedded absolute
  paths, timestamps, generated config drift, or linker nondeterminism;
- `pptoken` inception drift that has not been fixed before the full
  `cppgm++` inception compare;
- missing reducers for earlier compiler bugs discovered while reaching
  inception;
- stringly semantic facts, ownership problems, avoidable hot-path recomputation,
  excessive copying, or file-size/file-audit bypasses.

Fix every blocker found. Do not document unresolved architecture, performance,
cheating, regression, reproducibility, or audit problems as future work. Update
`pa39/plan.md` with `Architecture Review` and `Final Architecture Review`
sections, and update `pa39/audit.md` with `Findings`, `Changes Made`, and
`Validation` before returning.

Required exit criteria:
{{modelValidation}}

Commit cohesive cleanup and leave `git status --short` empty before returning.
