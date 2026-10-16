Implement a coherent PA34 reference-bootstrap fix.

{{briefState}}
Results: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read REFERENCE_STAGES.md, spec.md and pa34/README.md. The selected profile is
@PROFILE@. R is the Rust C++ compiler, not rustc. S is the pinned unchanged C++
bundle. B=host(S); A=R(S); C=A(S); D=C(S). Student acceptance permits different
first-generation code and requires C==D plus A/D rebuilt suites; the port
profile additionally requires F=B(S) and F==A==C==D.

Use the configured object/tool progress check to group failures by the earliest
compiler boundary. Reduce inputs in student.tests and fix the Rust owner.
Keep source, flags, generated headers, logical paths and host-link/allocator
recipe fixed. Never substitute baseline objects into a failed candidate build.
The reference source is a workload, not an implementation to copy or delegate to.

Validate the changed path, Rust quality and prior correctness; reuse qualified
unchanged evidence. Update a compact stage plan/ledger with object IDs, first
failures and next dependency boundary. Commit cohesive changes and leave clean.
A validated coherent partial handoff can complete this phase goal. Full clean
bootstrap and rebuilt suites are required for assignment acceptance.

Ralph owns the native goal. Complete the existing handoff with update_goal;
do not create/replace goals or edit checker/Ralph state.

{{modelValidation}}
