Independently close PA34 reference bootstrap.

{{briefState}}
Results: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read REFERENCE_STAGES.md and pa34/README.md. Audit the @PROFILE@ profile:
complete clean A=R(S), C=A(S), D=C(S), C==D, and A/D rebuilt PA1–PA33/debug
suites with their own helpers. Port acceptance additionally requires F=B(S)
and F==A==C==D. Independent student codegen need not equal the reference's
first generation. All source, flags, paths, configuration and host-link inputs
must be fixed; failed compiles cannot borrow baseline objects.
Review actual Rust phase ownership, required ABI/IR contracts and quality.
Inspect the final proof and receipts rather than trusting partial progress.
Fix remaining defects, rerun invalidated acceptance and consolidate plan/audit
evidence. Commit and leave clean. Complete the audit goal only when the full
configured acceptance passes on final code.
Ralph owns the native goal; use update_goal for this existing handoff. Never
create/replace goals or edit checker/Ralph state.

{{modelValidation}}
