# v5rust: exact safe Rust clone

This run starts from a pinned `cppgm-extended` export, with a new Rust
implementation under `dev/`. The complete C++ solution and its freshly built
tools live outside the writable run volume. This preserves the maintainer
regressions and architecture contracts that the student export omits, while
preventing the existing C++ solution from satisfying the candidate checks.

The run is prepared independently of other runs. It does not stop or alter them.
See the installed checkout's `CLONE_CONTRACT.md` and `docs/rust-clone-plan.md`
for the implementation and validation contracts.

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

Checks use a protected manifest and scripts, count exact per-case outcomes,
and preserve previously passing case identities using Ralph's read-only state.
The ordinary C++ test workers are retained. Test-only adapters implement their
batch transport and compare actual Rust invocations against the oracle, using
identical input/output paths. They never supply oracle output to the candidate.
Production `dev/` executables run only Rust.

The private filesystem is mounted `nosuid,nodev`, owned by the runner with mode
0700. Bubblewrap exposes the host read-only and binds only private run storage
and provider state writable. The C++ reference, control bundle and Ralph state
are outside that storage. A systemd scope caps memory at 64 GiB with no swap.
Cargo caches and temporary files stay inside the private volume.
