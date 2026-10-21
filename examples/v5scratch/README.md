# V5 scratch Rust student compiler

`v5scratch` starts from `cppgm-assignments` tag `v5`, pinned to
`4fc4f61d8897f09293a2ef9202fd49373c602a29`, with an empty safe Rust workspace.
It implements C++11 from the student handouts and fixtures. No implementation,
plan, audit, Ralph state or compiler source from another run is inherited.
The supplied reference binaries keep their ordinary course roles.
The published preparation snapshot has fresh Git history; the V5 tag is
verified before adaptation and its student-only source metadata is retained
as a local setup artifact.

The course test/report targets and their student comparisons are retained.
Rust tools occupy the expected `dev/` executable paths; Cargo builds them in
release mode. `CPPGM_BATCH_TESTS=0` uses ordinary workers, so no C++ embedded
batch runner or clone adapter is required. Starter vocabulary/scaffolds from
the assignments live under `docs/cpp-starter/`. They are optional handout
material, not a source-by-source porting checklist. Diagnostic spelling,
internal counters and optimized code bytes need not match a completed solution.
Course-defined output/ABI/quality facts still must match their contract.

The six prompt/goal templates follow v5sol's implementation, checkpoint and
final-audit workflow. Native Codex `gpt-6.1-sol`, high reasoning, fresh threads,
and checkpoint review every third partial handoff match v5sol. Safe Rust,
rustfmt, Clippy, Cargo tests and a syntax-aware Rust file audit are required.
The architecture/performance spec preserves typed phase boundaries and bounded,
question-driven measurements, translating C++ ownership rules into Rust.
Validation shares results between equivalent Make/direct check commands on
unchanged inputs and options, with focused controls and compact evidence updates.
Ralph reloads prompt/goal sidecars before each new provider turn; edits apply
without restarting the worker. Config changes require a restart.

The run stops after the successful PA33 audit (`stopAfterStage: pa33`).
PA34/PA35 are deferred; their original handouts remain available. No inception
proof or PA35 self-build/performance gate is claimed by this run.

The optional [reference-stage extension](../rust-reference/README.md) prepares
reviewed PA34/PA35 handouts, checks and native goal templates for installation
after PA33. It leaves this scaffold's default endpoint and active run unchanged.

Paths:

| Purpose | Path |
| --- | --- |
| Checkout | `/home/vishvananda/work/v5scratch` |
| Private filesystem | `/home/vishvananda/work/private/v5scratch` |
| Config | `/home/vishvananda/work/v5scratch.config.json` |
| Protected runtime/checks | `/home/vishvananda/work/v5scratch-control` |
| Default Codex profile | `~/.codex` (or the ambient `CODEX_HOME`) |
| Ralph state | `/home/vishvananda/work/.ralph/v5scratch-gpt-6.1-sol-high` |

The run uses Ralph's ordinary Bubblewrap storage setup and the default Codex
profile, so a normal `codex login` updates its authentication. Host paths remain
readable; writable checkout, Cargo caches, scratch, outputs and performance
evidence stay in the private volume. The 100 GiB filesystem remains
`nosuid,nodev`; the memory scope is 64 GiB with no swap. The student instructions
retain their requirement to implement from handouts rather than completed
compiler sources.

Install once; this refuses existing run paths and never formats an existing LV:

```sh
bash examples/v5scratch/install.sh
```

The installer verifies the setup, commits the preparation and pushes a private
`vishvananda/cppgm-run-v5scratch` repository. It leaves the run unstarted.
Launch separately, using the same style as the existing runs:

```sh
cd /home/vishvananda/work
RALPH_CONFIG=/home/vishvananda/work/v5scratch.config.json node /home/vishvananda/cppgm-ralph/ralph.js
```

For Rust, `make build`, `make rust-quality` and `make audit-rust` replace the
C++ build/file audit. Keep `make test-paN` and `make test-report-through-paN`.
The Rust adaptation and PA33 endpoint override the student starter's C++ build
and PA34/35 instructions; all PA1–PA33 student language/test contracts remain.
