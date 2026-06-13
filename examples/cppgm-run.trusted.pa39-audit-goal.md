Ralph loop {{turnNumber}} audit phase for {{runName}}.

Audit PA39 inception and clean up before finishing the run.

Completion criteria:
- `pa39/audit.md` includes Audit Plan, Findings, Changes Made, and Validation.
- `pa39/plan.md` includes Architecture Review and Final Architecture Review
  grounded in the actual implementation.
- Any PA39-only shortcuts, self-hosting special cases, generated source-set
  scans, skipped work, embedded payloads, fixture gates, timeout workarounds,
  harness weakening, reproducibility hazards, missing reducers, stringly facts,
  ownership problems, performance blockers, or file-audit bypasses found during
  audit are fixed, not deferred.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed as cohesive progress commits.
- `git status --short` is empty before handing control back.
