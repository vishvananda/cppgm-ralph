Ralph loop {{turnNumber}} audit phase for {{runName}}.

Audit `{{testStage}}` and clean up the implementation before moving on.

Completion criteria:
- `{{testStage}}/audit.md` includes Audit Plan, Findings, Changes Made, and
  Validation.
- `{{testStage}}/plan.md` includes Architecture Review and Final Architecture
  Review grounded in the actual implementation.
- Any skipped work, dummy outputs, interpreter/VM/trampoline/template-binary or
  embedded-payload substitutes, fixture/test-specific gates, timeout workarounds,
  file-audit bypasses, stringly facts, ownership problems, or performance
  blockers found during audit are fixed, not deferred.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed as cohesive progress commits.
- `git status --short` is empty before handing control back.
