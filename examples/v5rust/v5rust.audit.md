Audit {{testStage}} for full stage acceptance.

{{briefState}}
Results: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read AGENTS.md, CLONE_CONTRACT.md, spec.md, the full handout, source map and
stage ledger. Audit all stage-owned C++ responsibilities, including behavior
not exercised by current tests. Compare control flow, numeric rules, failures,
diagnostics, order/tie-breaks and externally visible bytes. Do not certify a
stage only because fixtures pass. Check that due compiler work runs in Rust;
oracle tools may only perform the documented harness/evaluation roles.

Apply CLONE_CONTRACT.md's protected stack qualification to resource-limited
audit probes. Require exact successful larger-stack results; native exhaustion
cutoffs and diagnostic positions are not defects to reproduce or calibrate.

Review the architecture and Rust idioms: parse once, typed facts and IDs,
bounded transactional parsing, explicit demand, complete cache keys, owned
storage, per-function backend lifetimes and deliberate target arithmetic.
Enforce source/function/nesting limits, safe code, rustfmt and strict Clippy.
Avoid fixture tailoring and blanket allowances. Fix findings and validate the
fixes before accepting the stage; retain every previously passing case.

Run the exact stage gate, its original full course suite and all earlier
stages. For PA33 also complete release/debug checks and ensure every C++
implementation responsibility has a Rust owner and no unfinished production
path remains. PA32 and PA33 preserve existing optimizer/backend policies;
PA35 optimization objectives are excluded. Record resource observations for
affected hot paths separately from generated-code equality.

Use focused controls while fixing findings; refresh invalidated gates once
after stabilization. Protected successful prior/quality receipts may be reused
only with identical inputs and intact raw evidence; --fresh forces execution.
Current-stage/course/release/bootstrap acceptance still runs. Index evidence
with python3 scripts/clone_evidence.py; do not copy every prior receipt or
write count-specific validators. Keep historical reports in Git and replace
the compact current ledger with reviewed commits, completeness, findings and
evidence links. Commit the audit/fixes and leave a clean checkout.
Complete Ralph's existing phase goal and return an evidence-backed handoff.
Do not create/reset the goal, change acceptance policy or edit Ralph state.

{{modelValidation}}
