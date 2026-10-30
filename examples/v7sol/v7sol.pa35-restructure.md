Restructure one PA35 owner.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- primary log: `{{lastTestLogPath}}`

Read `pa35/README.md`, the plan's mechanism ledger, the latest `measure`
attribution (owners, mix, functions, calls) and the owning design notes. Rank the
remaining excess by mechanism. For the largest, name the model that produces
it (a placement rule, an admission rule, a transfer modeled before emission
needs it, a pass blind across a boundary), not the threshold around it. If
the batches since the last restructure gained little against it, that model
is the owner to replace now.

Replace the model this turn: state the property the new design guarantees
(spec section 7), its complexity bound and the excess classes it removes.
Build it completely, with earlier contracts, debug locations, unwinding and
determinism intact, and redesign the owner's own tests. Do not keep the old
model beside the new one behind a flag, and do not tune thresholds instead.
The design stays yours: the reference and GCC are yardsticks, not models to
copy.

The turn ends when the new model is correct and the refreshed canonical groups
keep every saved rung; a gain is not required, the batches that follow harvest
it. Do not revert a complete design that measures short; finish it. Run the
generated-seed check for allocator/MIR changes and inception. Record in the
mechanism ledger the owner, the property, the measured effect and what remains.

Preserve course contracts and reference outputs. Corrections require a reduced
reproducer, cited C++11/LowIR rules and the bundle revision; compiler agreement
alone is not proof. Keep personal tests in `student.tests/`.

Required checks:
{{modelValidation}}

Commit cohesive changes and leave `git status --short` empty.

Ralph owns the native phase goal. Return a validated handoff, call `update_goal`
with status `complete`, and finish the turn. Partial completion ends a turn,
not the assignment. Never create or replace goals, edit Ralph state, or wait
for Ralph-owned checks.
