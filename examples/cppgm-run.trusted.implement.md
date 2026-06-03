Implement `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Before editing, read `AGENTS.md`, `TESTING_AND_REFERENCES.md`,
`{{testStage}}/README.md`, and the relevant tests. Create or update
`{{testStage}}/plan.md` before substantial implementation; keep it focused on
the intended compiler design, ownership boundaries, and validation plan.

Build on the compiler from previous assignments. The current stage is the next
increment in the same compiler, not a separate implementation path. Preserve
older behavior; if an older stage or prior gate fails, fix that regression as
part of this turn.

Implementation bar:
- Implement the real language/compiler behavior required by the assignment.
- Do not skip parser, semantic, lowering, object, runtime, or tool work to make
  a test pass.
- Do not implement an interpreter, VM, trampoline, templated executable, copied
  runtime driver, or embedded earlier-IR payload as a substitute for the
  compiler artifact the assignment requires.
- Do not emit dummy, empty, stub, or minimal outputs instead of compiling the
  source.
- Do not use test names, fixture paths, reference outputs, source-shape probes,
  or hardcoded expected behavior as acceptance gates.
- Do not work around timeouts by weakening work, skipping work, suppressing
  checks, changing the harness, or hiding slow paths.
- Use typed compiler state for semantic facts; do not recover semantics from
  formatted text when the compiler should already know the fact.
- Keep algorithms, data ownership, and file layout suitable for later
  assignments.

Testing workflow:
- Use `make test-report ACTIVE_TEST_REPORT_PAS='{{testStage}}'` for fast
  diagnosis inside the current assignment.
- After a meaningful parser, semantic, lowering, object, runtime, or shared
  infrastructure change, run the required through check, not only the scoped
  report.
- If the through check shows an older failure, treat it as part of the current
  bug. Fix the regression before continuing with current-stage feature work.
- Prefer small commits after stable checkpoints so regressions are easier to
  isolate.

Required exit criteria:
{{modelValidation}}

The file audit is implemented at `scripts/cppgm_file_audit.pl`. Treat its
findings as design blockers, not text to suppress. Commit cohesive progress and
leave `git status --short` empty before returning.
