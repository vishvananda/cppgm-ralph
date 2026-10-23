# PA34/PA35 for a Rust C++ compiler

This optional extension prepares both the independent student and exact-port
runs for a frozen C++ reference bootstrap and compiler optimization. Existing
scaffolds keep their original stop. Preparation writes a new directory only;
it never changes a checkout, live config, protected control bundle or Ralph state.

Use the handouts and scripts from cppgm-extended's long-lived `rust-course`
branch, or its student export. This branch has one Rust procedure per assignment;
the C++ self-hosting handouts remain on `main`. Preparation checks the branch's
`scripts/rust_course.json` marker and refuses mixed-track course inputs.
Create one bundle from an explicitly pinned published reference
revision, outside either candidate checkout, using `reference_bootstrap.py
snapshot`. Keep it available at the same absolute path inside the run sandbox.
It contains completed C++ sources: introduce it to the student only after PA33.

```sh
python3 examples/rust-reference/prepare.py \
  --config /home/vishvananda/work/v5scratch.config.json \
  --course /home/vishvananda/cppgm-extended \
  --bundle /path/to/pinned-reference-source \
  --profile student --out /path/to/new-staging-directory
```

For v5rust select its config and `--profile port`. PA34 preserves its stronger
first-generation equality. PA35 explicitly transitions to ordinary course
correctness/ABI/quality contracts, allowing optimization differences while
retaining the recorded exact-port proof. The old clone comparator remains
unchanged and continues to govern PA1–PA33 and the port's PA34 prior check.
PA35 runs earlier course/debug suites directly against actual Rust binaries.

The output contains a complete staged config and prompt/goal sidecars,
`candidate/` file replacements and an `activation.json` inventory. The agent guide, spec and run overview are edited in place to remove obsolete
stop/exclusion rules; no appended override document or second handout is installed.
PA34's staged handout states only the selected student or port acceptance.
`pa35/reference.mk` records the run's bundle and actual release tools so plain
PA35 commands use the correct inputs. For a port,
both the candidate and control protected manifests are staged with the new
reviewed hashes. Source fixtures, oracle revision and oracle binaries are
unchanged. Read the generated changes before installing them.

Install scratch at its automatic stop after the successful PA33 audit. For
the existing port, retain its current PA34 proof and install the continuation
at its automatic stop after PA34. Commit the reviewed candidate replacements,
update the optional protected control manifest, then restart Ralph using the
staged config. Its sidecars must stay
beside that config. The config preserves the run name, workdir and state path,
extends stages through PA35, and uses the actual Cargo release binaries.
It leaves earlier-stage prompts/checks intact. The student's prior gate keeps its
normal through-PA33 comparisons and PA8/PA32/PA33 debug targets; strict LowIR
text comparison belongs to the rebuilt C++ generations, not the independent Rust compiler. Do not install over an active
worker or manually advance/edit Ralph or goal state.

Keep Rust handout changes on `rust-course`; update it deliberately with future
course fixes. Validate that branch's CI and student export before installing;
do not merge its instruction changes into the C++ course on `main`.
The frozen workload bundle can remain pinned
to an earlier agreed reference revision; its source must not drift as R changes.
PA35 retains the published 17 limits and deterministic final counter scopes.
Preparation includes `pa35/gates.txt` with the Rust handout and scripts, so a
course refresh cannot leave older limits behind. PA35 prompts use coherent
optimization batches, focused iteration and one canonical refresh at handoff;
historical plans remain evidence rather than recurring checklists. Preserve the
Rust quality, prior/debug and final bootstrap requirements when adapting prompts.

When refreshing an active PA35 rubric, pause at a clean turn boundary and retain
the old policy and receipts. Install the reviewed handout, gates and protocol
together, then refresh the affected canonical groups. A limit change can change
the rung denominator without removing tests. Before creating the next native
goal, start Ralph with `stop-after-turn` present so its checks record the new
baseline and exit. Confirm the preservation check uses the new denominator on
both sides. Resume with fresh goal templates; `--reuse-last-checks` can reuse
that verification if its inputs are unchanged. Never pad rungs, waive coverage
or continue a blocked goal whose validation still describes the old rubric.

## Existing run rollout

| Run | Installation boundary | Work enabled |
| --- | --- | --- |
| v5scratch | After its existing PA33 stop | Independent reference bootstrap, then PA35 |
| v5rust | After its existing PA34 stop | PA35; retain the completed strict port proof |

Keep both active runs' instructions unchanged until those stops. Fixture-level
byte parity does not prove the reference source builds: the port's PA34 must
still compile every source, match all objects/tools and pass rebuilt suites.
If those already pass, PA34 is verification rather than a new implementation.

At each boundary:

1. Confirm the successful final audit and stopped worker. Record the candidate
   commit and preserve the active config, sidecars, control manifest and final
   acceptance evidence. Do not edit Ralph or native goal state.
2. Regenerate preparation from the then-current checkout/config and reviewed
   `rust-course` revision. Earlier prepared manifests are previews, since course
   corrections or protected inputs may have changed. Use the same immutable
   reference bundle revision for both runs; do not update the port's oracle or
   merge the C++ solution tree into a Rust checkout.
3. Review and commit the staged handouts, scripts, policy replacements and
   `reference.mk` as one owner migration. Install both protected manifest copies
   for the port. Keep PA1–PA33 fixtures and effective checks unchanged. Validate
   the config/dependency chains, release build, Rust quality/file audit, prior
   acceptance and a PA35 smoke check where supported. Confirm the configured
   commands and perf counters work in the run sandbox.
4. Select the prepared config and its colocated prompt/goal sidecars. Preserve
   the run name, workdir and state path; extend the endpoint to PA35 and restart
   the worker in its existing pane. Let normal stage advancement choose PA34
   for scratch or PA35 for the completed port, then verify its first turn.

For the port's PA35, freeze the accepted Rust release compiler and PA34 proof
first. Establish throughput, RSS, scaling and generated-code baselines before
editing. Begin with Rust implementation speed/memory changes that preserve
generated object bytes on fixed inputs; algorithmic work counters may change
under the explicit PA35 contract. Its codegen already reproduces the reference
backend, so substantial generated-code work may be unnecessary. The full
published gates decide completion. A later backend/codegen optimization is a
separate, recorded step; preserve the original port proof and measure both
compiler throughput and constant-source generated-code effects independently.

No fresh run or replay of PA1–PA33 is needed for this continuation. Keep the
pre-PA35 compiler and evidence immutable so future comparisons distinguish the
completed exact port from its subsequent optimization work.
