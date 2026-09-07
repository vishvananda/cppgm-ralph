Perform the final audit for `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Perform an independent PA-wide review of the actual implementation. Read
`spec.md`, the assignment README, stage commits, changed source, and current
plan, but do not assume checkpoint conclusions are complete. Reconstruct the
stage architecture and compare it with the relevant normative requirements.

Apply the `spec.md` architecture audit checklist, adapting it to the language
and compiler surfaces available in this PA. Trace representative stage data
end to end, measure scaling-sensitive workloads, and profile unexplained slow
paths. Fix every correctness, architecture, performance, self-containment, or
file-audit blocker across its full ownership path rather than one symptom.

Finish with a compact plan containing current Stage Design and Spec Alignment,
Performance Evidence, Architecture Review, Final Architecture Review, and the
checkpoint ledger. Consolidate the audit into its ledger plus final Findings,
Changes, Performance Evidence, and Validation.

Required exit criteria:
{{modelValidation}}

Commit cohesive refactors and cleanup and leave `git status --short` empty.
