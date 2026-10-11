Audit PA35 final optimization acceptance.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Independently review the whole stage against its handout/spec: transform
legality and budgets, typed ownership, bounded compiler work, frame/unwind/debug
behavior, constant-work codegen attribution and deterministic self-compilation.
Check reducers and prescribed generated-seed coverage. Fix known violations.

Use the supplied measurement cache and valid evidence while fixing code. After
fixes stabilize, run canonical `make -C pa35 test`: all 17 gates must pass on
final code, with `make test-report-through-pa33` and canonical inception still
passing. Quick counts, cached rung summaries, reference parity and exploratory
PMU results cannot substitute for any final gate. Preserve the workload manifest,
gates, protocols, equal allocators and build/link assumptions. Run a broader
measurement only to resolve a stated gap; consolidate evidence once.

Record final compiler speed/scaling, generated-code counts/proxy/size, validation,
architecture owners and remaining limitations in the compact plan/audit.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph creates and schedules the native phase goal. Satisfy this phase, call
`update_goal` with status `complete`, and return a validated handoff. Partial
implementation completion ends this turn, not the assignment. Never create or
replace the goal, edit its state, or wait for Ralph-owned checks.
