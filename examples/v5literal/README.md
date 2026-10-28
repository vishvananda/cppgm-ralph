# v5literal: source-driven mechanical Rust translation

A fresh experiment using the same C++ source pin as v5rust, with no Rust code
copied from another run. Translate the original file/function structure and state
lifecycle first; defer optional rewrites and optimization. Narrow reviewed unsafe
code is allowed. See candidate-AGENTS.md (installed as AGENTS.md),
CLONE_CONTRACT.md, spec.md and porting.md for the installed contract.

Pins: C++ `22cd2cd17f660b765c8118e9675fab676daec714`, assignments
`829dd5d2c7e5abba72ce5e58985e15e6bb6576c2`. The independent reference checkout is
`~/work/references/v5literal-cpp`. Nine verified C++ seed binaries are copied from
the identical frozen oracle; they are read-only evaluators, never candidate code.

The source census freezes 408 `.cpp`/`.h` files and their function definitions.
Mapped Rust paths retain directories and distinguish headers (`*_h.rs`) from
implementation (`*_cpp.rs`). A completed row needs actual production inclusion,
complete distinct function correspondence, current source hashes, whole-source
review and intact successful validation evidence. Unsafe syntax has its own exact
review ledger. Parser gaps require explicit range review. These checks support
source review; they cannot establish semantic equivalence by themselves.

Ralph uses **PA33 as a whole-source inventory label**, initially 0/408. This is
not assignment-by-assignment development and does not claim prior assignments
passed. Source batches drive implementation/checkpoint reviews; all original
PA1–PA33 differential/course/debug checks become mandatory for final closure.
PA34 then proves clean C1==C2==CR==C3 and rebuilt suites. PA35 is excluded.

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

The GitHub Actions configuration is saved as `ci/rust.yml` in the run and
`rust.yml` in this example. Local verification runs the checks. Enabling Actions
requires copying the template into `.github/workflows/` with workflow-authorized
credentials; the current GitHub OAuth credential cannot publish that path.
