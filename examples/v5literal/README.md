# v5literal: source-driven mechanical Rust translation

A mechanical Rust translation now pinned to cppgm-extended V8, with no Rust
code copied from another run. Translate the original file/function structure and state
lifecycle first; defer optional rewrites and optimization. Narrow reviewed unsafe
code is allowed. See candidate-AGENTS.md (installed as AGENTS.md),
CLONE_CONTRACT.md, spec.md and porting.md for the installed contract.

Pins: C++ `8d4c68b9e37976a0c290109bcc9f63f1b4e95cea`, assignments
`0755b5f68b801456bc077c78811b11165f292d94`. The independent reference checkout is
`~/work/references/v8literal-cpp-8d4c68b9` for the migrated run. Nine hash-verified V8
release tools are installed as read-only evaluators, never candidate code. A fresh
installation uses its own `v5literal-cpp` checkout at the same V8 pin.

The source census freezes 457 `.cpp`/`.h` files and their function definitions.
Mapped Rust paths retain directories and distinguish headers (`*_h.rs`) from
implementation (`*_cpp.rs`). A completed row needs actual production inclusion,
complete distinct function correspondence, current source hashes, whole-source
review and intact successful validation evidence. Unsafe syntax has its own exact
review ledger. Parser gaps require explicit range review. These checks support
source review; they cannot establish semantic equivalence by themselves.

Ralph uses **PA33 as a whole-source inventory label**, initially 0/457. This is
not assignment-by-assignment development and does not claim prior assignments
passed. Source batches drive implementation/checkpoint reviews; all original
PA1–PA33 differential/course/debug checks become mandatory for final closure.
PA34 then proves clean C1==C2==CR==C3 and rebuilt suites. PA35 is excluded.

The viewer uses a separate source-file completion chart rather than PA cost
milestones. Provider/check scopes have a two-CPU quota (`200%`); Cargo and course
checks use two jobs. Elapsed build times reflect that limit.

The literal audit replaces safe/idiomatic-port style, file/function size and
phase-dependency rules. It retains formatting, correctness lints, unsafe docs,
source correspondence and the unchanged exact comparator/stack qualification.
Existing comparator/bootstrap helpers are copied from the sibling v5rust example
at installation; their source is versioned together in this repository.

Install on this host:

```
python3 examples/v5literal/install.py
```

The installer refuses existing run/storage/reference paths and creates a new
private remote `vishvananda/cppgm-run-v5literal`. It provisions a 100 GiB LVM
filesystem at `~/work/private/v5literal` when extents are available, and otherwise
uses a sparse capped loop image. It persists the mount in fstab. The installed
run uses `/dev/vg0/cppgm_v5literal`. An absent mount fails closed.
Code, tmp, caches and artifacts are writable only inside that filesystem;
control/oracle/state remain protected. Other checkouts are not hidden.

Provider authentication remains the user's default Codex login. The launcher
sets only Cargo cache/target and Clippy configuration paths. Ralph uses the native
Codex harness with gpt-6.1-sol/high, fresh threads per handoff and 64 GiB RAM.
Its own state/log namespace is `~/work/.ralph/v5literal-gpt-6.1-sol-high`.

Verification checks real protected routing, all nine stub exits, a C++ oracle
self-check, expected candidate mismatch, source/unsafe/checker regressions and
bwrap storage isolation. A mocked provider exercises the actual Ralph config
without a model call, actual run state or stage advancement. Reports are under
`private/v5literal/artifacts/setup-verification/`. Installation leaves it stopped.

Launch when ready:

```
ulimit -S -s 16384
RALPH_CONFIG=/home/vishvananda/work/v5literal.config.json node /home/vishvananda/cppgm-ralph/ralph.js
```

The first native goal establishes the original C++ ownership/representation
conventions and translates a finite dependency batch. Each subsequent goal is a
bounded source translation or independent source review, not an entire compiler.
At a clean, validated handoff, explicitly complete the native goal and return;
Ralph refreshes progress gates afterward.

The GitHub Actions configuration is saved as `ci/rust.yml` in the run and
`rust.yml` in this example. Local verification runs the checks. Enabling Actions
requires copying the template into `.github/workflows/`. Git fetches and pushes
use the host's default forwarded SSH agent without a per-run credential helper.

## Updating an existing translation

The existing run was migrated from C++ `22cd2cd17f66` to V8 on 2026-11-02,
keeping its name, history and Rust implementation. The census grew from 408 to
456 files: 102 completed sources were unchanged, 80 completed sources need
recovery, and 48 files were added. Changed source rows become pending; old
reviews remain available but cannot certify new source hashes. The refreshed V8
release adds one source and changes six, bringing the census to 457. Subsequent
updates carry forward unfinished recovery with each file's original diff baseline;
backups and measurement namespaces include the pinned revision.

`reference_update.py` previews the source delta by default. With `--apply`, it
backs up control/port/evidence metadata, synchronizes reference-owned inputs,
repins oracle/source/fixture hashes together and writes `port/reference-update.json`.
The worker must be stopped, both checkouts clean, the new reference detached at
the release tag and its nine oracle tools independently verified beforehand.
After updating instructions, refresh protected hashes, commit/push, update the
config's source total and restart with fresh checks and a fresh thread. Do not
use `--continue` or `--reuse-last-checks` across reference revisions. Bootstrap
work from the earlier pin is archived, not reused. If an interrupted thread still
has an active goal for the superseded inputs, archive it and clear it through
`thread/goal/clear` before the fresh start; do not mark it complete.

Recovery prompts prioritize changed completed sources in dependency groups,
then new translation. Revalidate usable milestones against the new oracle;
retain unchanged review evidence and avoid replaying unrelated historical audits.
Exact comparison and final PA1–PA33/debug/bootstrap requirements are unchanged.
