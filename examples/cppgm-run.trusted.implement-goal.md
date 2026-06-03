Ralph loop {{turnNumber}} implementation phase for {{runName}}.

Implement `{{testStage}}` as the next increment of the existing compiler.
Create or update `{{testStage}}/plan.md` before substantial implementation.

Completion criteria:
- The implementation builds the real compiler behavior and preserves previous
  assignments.
- No skipped work, dummy outputs, interpreter/VM/trampoline/template-binary or
  embedded-payload substitutes, fixture/test-specific gates, timeout
  workarounds, harness weakening, or hardcoded expected behavior are used.
- Scoped reports may be used for diagnosis, but older-assignment regressions
  found by through checks are blockers for this turn.
- File-size, file-audit, and architecture requirements are satisfied in
  substance.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed as cohesive progress commits.
- `git status --short` is empty before handing control back.
