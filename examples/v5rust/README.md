# v5rust: exact safe Rust clone

The optional [reference-stage extension](../rust-reference/README.md) prepares
a PA35 continuation after the strict PA34 proof. It explicitly switches PA35
to course correctness/ABI/quality contracts so valid optimizations are allowed;
the original clone checker and this scaffold's default endpoint stay intact.

This run starts from a pinned `cppgm-extended` export, with a new Rust
implementation under `dev/`. The complete C++ solution and its freshly built
tools live outside the writable run volume. This preserves the maintainer
regressions and architecture contracts that the student export omits, while
preventing the existing C++ solution from satisfying the candidate checks.

The run is prepared independently of other runs. It does not stop or alter them.
See the installed checkout's `CLONE_CONTRACT.md` and `docs/rust-clone-plan.md`
for the implementation and validation contracts.

The comparator keeps ordinary results exact. Native stack-guard exhaustion
uses a bounded larger-stack qualification that requires identical successful
results and retains raw evidence; it never accepts a crash or a timeout.

The example oracle pin is `3438f5aea24d8fcc9a0113316f7e27c890cd5ac6` (v5.1),
with matching assignment export `0bf28e39bca37f7e4173ae1e9ca557659ada7523`.
It retains the earlier compiler fixes and adds corrected control placement,
numbering and ordinary counted `control_t` `.t` inputs. The frozen manifest
contains 7,090 case anchors: PA7 has 214, PA9 123, PA10 167, PA11 409 and PA12
361. Compiler sources and all nine live oracle binaries are unchanged from
ee3596b2; earlier receipts from before its compiler fixes remain historical.

[Baseline updates](BASELINE_UPDATES.md) describes the owner procedure for an
existing run, including both copies of clone settings and the protected manifest.
The oracle revision is not a field in `v5rust.config.json`; its
`assignmentLayout: "v5"` remains correct for v5.1.

For an additional audit probe, set `V5RUST_TRACE` to a writable JSONL path and
invoke `python3 scripts/clone/clone_adapter.py cppgm++ --emit-ast -o OUT INPUT`.
Inspect the receipt's `match` and `stack_qualification`: the CLI keeps the
original candidate exit/outputs, which may still report stack exhaustion.

Paths on this machine:

| Purpose | Location |
| --- | --- |
| Checkout | `/home/vishvananda/work/v5rust` |
| Private 100 GiB filesystem | `/home/vishvananda/work/private/v5rust` |
| Pinned C++ reference | `/home/vishvananda/work/references/v5rust-cpp` |
| Protected checks and prompts | `/home/vishvananda/work/v5rust-control` |
| Ralph configuration | `/home/vishvananda/work/v5rust.config.json` |
| Remote | `vishvananda/cppgm-run-v5rust` (public) |

After setup verification, launch from `cppgm-ralph`:

```sh
RALPH_CONFIG=/home/vishvananda/work/v5rust.config.json npm run ralph
```

The loop starts at PA1 and stops after the audited PA34 clone proof. PA35 is
retained as reference material and a source of correctness workloads, but is
not a stage: this conversion must preserve existing code generation. PA32 and
PA33 still require exact ports of the existing optimizer and backend policies.

Implementation handoffs may make partial progress; every third accepted
handoff triggers a checkpoint audit. Full stage passage requires an audit
turn. Fresh threads recover context from committed `docs/port/paN.md` files
and the source ownership ledger. Native goals describe a coherent phase
handoff, not an impossible demand to finish an entire assignment in one turn.

Checks retain every protected manifest anchor and add discovered `paN/tests/**/*.t`
cases once, using the same differential checks and per-case reporting. This
includes regressions added during implementation or audit; missing frozen files
remain required. Passing identities from both sets are preserved using Ralph's
read-only state. The 2026-10-19 correction resolves a checkpoint blocker where
the frozen-only command omitted added controls but Ralph counted them as unrun.
The ordinary C++ test workers are retained. Test-only adapters implement their
batch transport and compare actual Rust invocations against the oracle, using
identical input/output paths. They never supply oracle output to the candidate.
Production `dev/` executables run only Rust.

Regular course suites use eight test workers by default, configured with
`course_workers` in the protected clone settings (and their committed copy).
Focused cases retain eight outer workers; each adapter still runs C++ and Rust
in order on identical paths. The separate PA34 bootstrap transport is unchanged.
On a fixed PA1–PA10 snapshot, raising course workers from one to eight reduced
the complete prior gate from 227 seconds to 74 seconds. All 1,156 frozen cases
and 2,046 full-course invocations passed with identical counts and output hashes.
These are elapsed times on a shared host; artifacts for the original experiment
are under `private/v5rust/artifacts/prior-parallel-benchmark/` on the setup host.

The 2026-10-11 harness correction recognizes standalone `preproc`, `lowir` and
`abimangle` statistics and excludes numeric `arena_bytes`/`name_arena_bytes`
from exact comparison, as required by the existing storage-measurement rule.
PA4's audit exposed an allocator-only mismatch despite identical generated
tokens and deterministic counters. Raw measurements remain in receipts;
diagnostics, field names, work counters and output artifacts remain exact.
The PA9 correction also excludes `abimangle`'s `peak_graph_bytes`, which
counts reserved allocator storage; graph node counts remain exact.
For an existing run, install the corrected comparator, tests and contract in
the protected control bundle and checkout, update only their protected hashes,
and record the revision and revalidation evidence before restarting its audit.

The private filesystem is mounted `nosuid,nodev`, owned by the runner with mode
0700. Bubblewrap exposes the host read-only and binds only private run storage
and provider state writable. The C++ reference, control bundle and Ralph state
are outside that storage. A systemd scope caps memory at 64 GiB with no swap.
Cargo caches and temporary files stay inside the private volume.
