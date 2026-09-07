Audit the latest checkpoint for `{{testStage}}`.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- full primary log: `{{lastTestLogPath}}`

Read `spec.md`, the active checkpoint in `{{testStage}}/plan.md`, its commits
and changed source, and the assignment README. In `{{testStage}}/audit.md`,
replace the Current Checkpoint Review and add one concise Checkpoint Audit
Ledger row. Preserve only durable architecture decisions.

Keep the review bounded to the landed increment. Confirm earlier assignments
pass, the checkpoint failure count is not exceeded, and test coverage is not
reduced, then apply the relevant
`spec.md` requirements and audit checklist. Trace any violation through the
complete affected ownership path and fix the checkpoint-level problem. Support
material performance conclusions with representative evidence.

After validation, refresh the plan's Spec Alignment, failure map, performance
evidence, next substantial checkpoint, and completed-checkpoint row without
retaining superseded inventories or transcripts.

Required exit criteria:
{{modelValidation}}

Commit cohesive audit fixes and leave `git status --short` empty.
