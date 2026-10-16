# PA34/PA35 for a Rust C++ compiler

This optional extension prepares both the independent student and exact-port
runs for a frozen C++ reference bootstrap and compiler optimization. Existing
scaffolds keep their original stop. Preparation writes a new directory only;
it never changes a checkout, live config, protected control bundle or Ralph state.

Use the updated cppgm-extended handouts and scripts from the reference-bootstrap
branch/export. Create one bundle from an explicitly pinned published reference
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
`candidate/` file replacements and an `activation.json` inventory. Policy
addenda update AGENTS/spec/clone-contract precedence at PA34/35. For a port,
both the candidate and control protected manifests are staged with the new
reviewed hashes. Source fixtures, oracle revision and oracle binaries are
unchanged. Read the generated changes before installing them.

Install at a paused boundary after the successful PA33 audit: commit the
reviewed candidate replacements, update the optional protected control
manifest, then restart Ralph using the staged config. Its sidecars must stay
beside that config. The config preserves the run name, workdir and state path,
extends stages through PA35, and uses the actual Cargo release binaries.
It leaves earlier-stage prompts/checks intact. Do not install over an active
worker or manually advance/edit Ralph or goal state.

For a release, publish the handout/harness changes through extended CI and the
student export before installing. The frozen workload bundle can remain pinned
to an earlier agreed reference revision; its source must not drift as R changes.
PA35 retains the published 17 limits and deterministic final counter scopes.
