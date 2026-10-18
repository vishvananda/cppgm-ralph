# Updating a running compiler baseline

Student runs and the exact Rust port use different baseline sources. Update
them at checked handoffs, preserve their implementations and keep the source
revision, grading inputs and protected configuration consistent. These are
owner operations; the compiler worker must not modify its frozen gate.

## Release pins

| Repository | Tag | Commit |
| --- | --- | --- |
| cppgm-extended | v5.2 | `ddcec92a2b2aa2376c858ae1aa3a6c18383b1aec` |
| cppgm-assignments | v5.2 | `017f950a1b28ea8ea9ee24a48c4192cbe6a75033` |
| cppgm-extended | v5.1 | `3438f5aea24d8fcc9a0113316f7e27c890cd5ac6` |
| cppgm-assignments | v5.1 | `0bf28e39bca37f7e4173ae1e9ca557659ada7523` |

The assignments export's `reference-binaries/manifest.tsv` must pin the matching
extended source commit. Publish extended only after its PR checks pass, wait
for main CI and the automatic assignments export, verify the pins, then tag
both repositories. A release tag alone does not update an existing run.

## v5.2: PA21 lifetime acceptance

v5.2 fixes static-initialization completion in the reference compiler and moves
26 PA21 lifetime regressions to behavior controls. Twelve now assert their
previously printed traces. A new completion regression brings PA21 to 233 tests
(172 LowIR/fact fixtures and 61 controls). The PA33 link to a moved fixture
also changes. Compiler sources change, so an exact Rust-port oracle update
requires rebuilding and repinning its tools; changing only the course tag is
insufficient. The v5.2 fix passed PA35 smoke and frozen-workload hardware-counter
comparisons without a measured instruction-count regression.

For a student run already on export `9209cd392`, cherry-pick the v5.2 export
commit with `-x`. Keep unrelated local corrections. Modified reference sidecars
retired by these reviewed control moves are removed with their old fixtures;
the controls use their stated outcomes instead. Verify the source/spec hashes,
new manifest and real checks, then update the run's assignment provenance.

When a course update resolves a blocked goal's acceptance issue, retain that
old goal and its failed attempt history. After fresh checks, record the new
baseline and schedule the required audit with a fresh native goal; do not mark
the old blocked goal complete or skip the audit. Passing controls do not waive
unresolved structural or correctness findings. The original v5.1 migration
instructions below remain useful for older baselines.

## Student runs: v5scratch and v5sol

Apply the seven assignment export commits in order, retaining provenance:

```sh
git fetch upstream tag v5.1
git branch backup/before-v5.1 HEAD
git cherry-pick -x $(git rev-list --reverse v5..v5.1)
```

Here `upstream` is cppgm-assignments, not cppgm-extended. Use the original v5
assignment tag as the range base even if the scaffold copied its tree without
Git ancestry. Check for already applied commits before replaying a range.
For v5scratch, the original assignments were a copied snapshot; no synthetic
merge parent is needed for these cherry-picks. v5sol has ordinary upstream
ancestry and can use the same seven-commit sequence.

Verify that `dev/`, the spec and run instructions are unchanged. Record the
new assignment commit and original base in `SCAFFOLD_BASE.json` or
`ASSIGNMENTS_BASE.json`. Run the through-stage report, record newly exposed
failures, commit the update record and push before resuming. Newly counted
controls and new earlier-stage regressions are normal required work; do not
turn them into expected failures or preserve old counts as a completion claim.

## Exact Rust port: v5rust

The Rust checkout already contains its course handouts, tests, references and
Makefiles. It does not need a separate cppgm-assignments checkout. Its inputs
come from the full pinned cppgm-extended tree, including maintainer regressions
that a student export omits. Keep the custom Rust root Makefile and protected
clone adapter/checker; do not replay the student export blindly over this run.

The C++ reference checkout is outside the writable candidate volume. On the
original host it is `~/work/references/v5rust-cpp`; the protected control bundle
is `~/work/v5rust-control`. The candidate has committed copies under
`scripts/clone/` for provenance.

Fetch the release into the separate oracle repository and resolve its commit
and tree before changing candidate files. Fetching in another checkout does
not populate this repository's objects. Check out the new oracle revision and
verify its tools/source hashes before importing the candidate's course inputs;
an unavailable commit must fail before any partial input installation.

Update these together while the worker is stopped:

| Item | Required update |
| --- | --- |
| Frozen C++ reference checkout | Detach at the reviewed extended commit; build changed tools and record their hashes. |
| Control bundle and candidate `scripts/clone/settings.json` | Update `revision`, matching `assignment_revision` and `assignment_tag`; preserve installed paths. |
| Both `manifest.json` copies | Update `revision`, protected input hashes and executed stage case lists; keep lint and comparison policy. |
| Oracle manifest inventories | Verify/update `oracle_sources`, `oracle_tools` and `source_responsibilities` against the pinned reference. |
| Course inputs and harness | Import reviewed additions, changes and removals, including obsolete paths after renames. |
| Both `CLONE_CONTRACT.md` copies | Record the new oracle revision. |
| Candidate `docs/port/baseline.md` | Record the old/new pins, changed behavior, counts and validation receipts. |

Changing only `revision` is insufficient: preflight validates actual protected
file and tool hashes. Refresh expected hashes only for the reviewed update,
after confirming the previous protected files match their existing manifest.
Never regenerate hashes indiscriminately to accept unexplained changes.

For v5.1, earlier oracle refreshes had installed compiler fixes and selected
regressions without all intervening control renames. Import the remaining
reviewed course changes from the original input snapshot through v5.1;
replacing only the last commit would miss the old names and misplaced cases.
Keep the Rust implementation, custom gates and source ownership ledger intact.

The manifest expands from 6,709 to 7,090 anchors. The extra 390 new/renamed
routes include 381 newly counted controls and nine renamed existing anchors.
PA24's old anchors are replaced by their new identities; retain or explicitly
map prior passing identities when refreshing a run that has reached those
stages. Existing PA11 passing identities are unchanged by this release.

Between ee3596b2 and v5.1, compiler sources and all nine installed oracle binary
hashes are unchanged. Verify that equality and record it; a fresh performance
comparison is unnecessary for a grading-only update. If compiler sources or
build inputs change in another refresh, rebuild and validate the affected
compiler behavior and performance before pinning the new baseline.

Run protected preflight, clone harness unit tests and oracle self-comparison
for every added/renamed route. Run the current Rust stage and verify previously
passing identities remain passing. Record partial stage failures faithfully;
new cases must not weaken the acceptance policy. Commit and push the candidate
baseline update before restarting with refreshed checks and a fresh phase goal.

## Ralph config and boundary handling

`v5rust.config.json` points checks at the protected clone bundle. It does not
contain the oracle SHA. Keep `assignmentLayout: "v5"` for the v5.1 release:
that value selects the stage layout, not an assignment Git tag.

`course_workers` in both clone settings copies controls regular course-suite
parallelism and defaults to eight. It does not change focused-gate coverage,
comparison policy or the separate bootstrap transport. An existing installation
also needs the matching `clone_check.py` in both the control bundle and candidate,
with its protected hash refreshed at a clean handoff. Record the validation and
commit the synchronized update before restarting.

Ralph reads `stopAfterStage` / `RALPH_STOP_AFTER_STAGE` at process startup.
For an active run, request its ordinary `stop-after-turn`, let its checks and
handoff finish, then restart with a temporary stage stop if needed. For the
v5sol migration, use `RALPH_STOP_AFTER_STAGE=pa20`, wait for successful PA20
audit completion and exit before PA21, perform the update, then resume without
that temporary override. Do not edit Ralph state or its native goal to move a
run across the boundary.

On the original host, the owner jobs are under `~/work/maintenance/`. Their
phase/result files and logs are under each run's
`private/<run>/artifacts/owner-v5.1-refresh/`. They wait for a clean stopped
checkout, retain backup branches and validation evidence, push before restart,
and leave the run paused if maintenance validation fails. These host-specific
jobs are separate from Ralph's runtime; inspect their status rather than
assuming that changing a JSON file has applied the baseline.
