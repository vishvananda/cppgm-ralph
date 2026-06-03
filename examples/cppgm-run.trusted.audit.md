Audit `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Review the implementation against `{{testStage}}/plan.md`, the assignment
README, recent commits, and changed source files. Before making audit changes,
create or update `{{testStage}}/audit.md` with an `Audit Plan` naming the files,
performance risks, ownership boundaries, and file-audit issues you will inspect.

Audit for:
- regressions against earlier assignments;
- skipped compiler phases or fallback success paths;
- dummy, empty, stub, or minimal output generation;
- interpreter, VM, trampoline, templated-binary, copied-runtime, or embedded
  earlier-IR-payload substitutes for required compiler artifacts;
- test-specific or source-shape acceptance gates;
- timeout workarounds instead of algorithmic fixes;
- stringly semantic facts, duplicated ownership, and downstream recovery of
  facts the compiler should represent earlier;
- avoidable quadratic scans, repeated full-suite walks, excessive copying, or
  hot-path recomputation;
- file-size/file-audit bypasses, hidden implementation fragments, weakened
  checks, or code moved to unchecked paths.

Fix every blocker found. Do not document unresolved architecture, performance,
cheating, regression, or audit problems as future work. Update
`{{testStage}}/plan.md` with `Architecture Review` and `Final Architecture
Review` sections, and update `{{testStage}}/audit.md` with `Findings`,
`Changes Made`, and `Validation` before returning.

Required exit criteria:
{{modelValidation}}

Commit cohesive cleanup and leave `git status --short` empty before returning.
