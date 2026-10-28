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

The example oracle pin is `b43173ec8d98b27eecf02bccabf973a4083a389f` (main),
with matching assignment export `22e677f46ffa27a8e003c0b53331c9188d151071`.
It includes the earlier reference/control fixes, corrected optimization-test
placement, the matching GCC O3 PA35 baseline, and converted vector lane builtin
lowering (extended PR #83). The scaffold builds and freezes all nine tools and
all source/case anchors at this revision; it does not reuse old oracle hashes.

[Baseline updates](BASELINE_UPDATES.md) describes the owner procedure for an
existing run, including both copies of clone settings and the protected manifest.
The oracle revision is not a field in `v5rust.config.json`; its
`assignmentLayout: "v5"` remains correct for these v5 course updates.

The scaffold ships a protected `dev/build.rs` and safe Rust host-configuration
capture module. It probes only empty host inputs at build time and embeds data
bytes for GNU/strict macros, include paths and driver queries. The runtime
frontend consumes those bytes without probing a host compiler. Both environment
inputs trigger Cargo rebuilds. Protected hashes cover the hook, capture logic
and data-import module; alternate build scripts and arbitrary include macros
remain rejected. Existing runs require an owner-reviewed installation of all
three files and the corresponding manifest/audit update before using the hook.

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
cases once, using the same differential checks and per-case reporting. Debug
fixtures retain their separate `test-debuginfo`/release targets, as in the frozen
manifest. A counted stage summary keeps those inventories distinct from generic
directory-count hints. This
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

## Reusing validation evidence

Protected `prior` and Rust-quality commands retain successful raw logs and a
content-bound receipt under `artifacts/clone/validation/`. Repeated handoff and
Ralph checks reuse that success only when candidate binaries/sources, course
inputs, control scripts/settings, toolchain/dependency metadata, relevant
environment and resource limits match, and every referenced raw evidence file
retains its hash. Failures are never cached. Changed/missing evidence reruns the
gate; `clone_check.py prior paN --fresh` or `clone_quality.py --fresh` forces it.
Current-stage tests, preservation, course and release/bootstrap checks still run.
No case, comparison, lint or acceptance requirement is removed.

During an open audit, use up to three read-only reviewers on disjoint owner
families; the parent integrates fixes and certifies the source map. Focused
tests and `python3 scripts/clone_quality.py --review` cover iteration without
creating a full-quality receipt. Record partial progress with:

```sh
python3 scripts/clone_evidence.py checkpoint pa33 --out review.json \
  --evidence focused-results.jsonl
```

This command labels missing/stale stage and prior/quality evidence, hashes the
referenced focused files, and never runs acceptance gates or modifies their
receipts. Use substantial milestones for full-suite refreshes while work remains;
final acceptance still requires every normal gate and the strict snapshot below.
Scaling studies are due when allocation or repeated-work behavior changes.
Translate C++ algorithms, persistent state and execution order before optional
Rust restructuring. Select a finite substantial batch with explicit closure
criteria: normally a whole source owner, or several related mechanisms for a
larger owner. Continue beyond isolated fixes, using focused checks between repairs
and one broad prior/full-quality refresh after the batch stabilizes. Ralph runs
the boundary stage/course/preservation/release gates; workers should not duplicate
them or repeat release/debug probes for known incomplete source ownership. A
handoff may finish before stage acceptance; only full review certifies an owner.

During PA33, `python3 scripts/clone/clone_bootstrap_probe.py --limit 4` compares
a bounded prefix of the frozen PA34 source inventory and stops at the first
object mismatch. `--source dev/src/path.cpp` selects a unit; `--start-after`
continues the inventory. Both compilers use the same frozen Makefile, logical
paths and O3 flags, with clean isolated probe outputs. Logs, hashes and objects
remain under `artifacts/clone/bootstrap-probes/`. This diagnostic neither
advances the stage nor supplies objects or acceptance evidence to PA34.

Validation identity fingerprints selected build/check tools (including PATH
shadowing and configured wrappers), system headers/libraries and Rust dependencies.
Installing an unrelated executable no longer invalidates an otherwise identical
receipt. The versioned identity change makes old receipts nonreusable; final
checks still require unchanged inputs and intact successful raw evidence.
Validation subprocesses use `validation_path` from the protected settings when
configured. Pin the owner's existing tool path at installation; temporary agent
PATH entries then neither change the selected tools nor prevent evidence reuse.
Diagnostic formatting is fixed with `LC_ALL=C`, `TZ=UTC` and `NO_COLOR=1` in
both worker and runner subprocesses.

After the final stage, prior and quality checks, create a compact index:

```sh
python3 scripts/clone_evidence.py snapshot pa29 \
  --out "$RALPH_ARTIFACT_DIR/pa29-current-evidence.json"
```

It checks current binary/manifest/case identities and valid prior/quality receipts,
then links the existing stage report and raw evidence without copying every case.
It is an index, not an acceptance certificate. Keep the current stage ledger
compact: owners, mechanism, counts, evidence links, findings and next dependency.
Earlier plans remain in Git. During implementation use small affected controls;
expand matrices, stack probes or resource measurements only for a concrete
changed invariant or unresolved question. Run full required checks once after
the related batch stabilizes and let Ralph reuse their unchanged evidence.

Install tool and prompt changes together while stopped, preserving an authorized
interruption's unfinished edits in a checkpoint commit.
Update only the reviewed protected file hashes in both manifests, retain the
oracle and all test identities, run harness regressions and real prior/quality
checks, then restart with refreshed instructions. Preserve successful cache receipts and
their raw files; never rewrite timestamps or outcomes to make them reusable.

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

The PA32 correction recognizes the reference optimizer’s `pa32_opt_stats`
format alongside `lowiropt_stats`. It applies the same measurement-field rule;
optimizer work counters and raw statistics receipts remain exact and retained.

The private filesystem is mounted `nosuid,nodev`, owned by the runner with mode
0700. Bubblewrap exposes the host read-only and binds only private run storage
and provider state writable. The C++ reference, control bundle and Ralph state
are outside that storage. A systemd scope caps memory at 64 GiB with no swap.
Cargo caches and temporary files stay inside the private volume.
