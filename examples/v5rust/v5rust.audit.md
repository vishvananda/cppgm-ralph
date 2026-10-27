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

Use up to three read-only subagents on disjoint C++/Rust owner families.
Require source ranges, concrete findings and minimal controls; keep edits,
source-map certification and gate execution with the parent. Review substantial
related groups, following shared producers and consumers before switching scope.

Apply CLONE_CONTRACT.md's protected stack qualification to resource-limited
audit probes. Require exact successful larger-stack results; native exhaustion
cutoffs and diagnostic positions are not defects to reproduce or calibrate.

Review the architecture and Rust idioms: parse once, typed facts and IDs,
bounded transactional parsing, explicit demand, complete cache keys, owned
storage, per-function backend lifetimes and deliberate target arithmetic.
Enforce source/function/nesting limits, safe code, rustfmt and strict Clippy.
Avoid fixture tailoring and blanket allowances. Fix findings and validate the
fixes before accepting the stage; retain every previously passing case.

While the audit remains open, use focused regressions and
python3 scripts/clone_quality.py --review. Index partial work with
python3 scripts/clone_evidence.py checkpoint {{testStage}} --out PATH --evidence FILE.
This records current/stale evidence without acceptance or full-suite receipts.
Do not freeze implementation for a full prior/quality run after each owner or
small fix. Reserve broad checks for substantial audit milestones and final closure.
Measure two supported scales only when allocation, repeated work or scaling
changes; ordinary byte-parity fixes need focused equality controls.

Before acceptance, run the exact stage gate, original course, all prior stages,
full quality and applicable release/debug/bootstrap checks; then use the strict
snapshot evidence command. Reuse success only with identical protected inputs
and intact raw evidence. For PA33 close every implementation responsibility and
unfinished production path. Preserve optimizer/backend policy; PA35 is excluded.
Keep the current ledger compact: reviewed tip/owners, findings, evidence and next
boundary. Retain history/raw logs, commit coherent fixes and leave clean.
Complete Ralph's existing phase goal and return an evidence-backed handoff.
Do not create/reset the goal, change acceptance policy or edit Ralph state.

{{modelValidation}}
