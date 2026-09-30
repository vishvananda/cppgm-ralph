# V4.1 Sol 6.1 Strands run

This run uses the Strands harness with `gpt-6.1-sol` at `high` reasoning
effort. It starts from `cppgm-assignments` tag `v4.1`, commit
`b0bb8b60de5882b7debf5bcc530e4ff7411b3ecc`, before PA1 implementation.
The run adds `spec.md` and `scripts/cppgm_file_audit.pl` from the clean
v4strands scaffold without carrying forward any implementation or run state.
The PA1–PA34 checks and all ten phase prompt/goal sidecars follow the versioned
v4strands example, with implementation handoffs explicitly returned to Ralph
for goal management and verification. The checkout is backed by
[cppgm-run-v4sol61strands](https://github.com/vishvananda/cppgm-run-v4sol61strands),
with `cppgm-assignments` retained as the `upstream` remote.

The checkout is `/home/vishvananda/work/v4sol61strands`, a symlink into
`/home/vishvananda/work/private/v4sol61strands/checkout`. The private write root
has a dedicated, preallocated 20 GiB ext4 filesystem backed by
`/mnt/vizier/v4sol61strands.ext4`. Checkout files, verification artifacts, caches,
`/tmp`, `/var/tmp`, and `/dev/shm` share that capacity. Its mount is configured
in `/etc/fstab`, with a dependency on `/mnt/vizier`.

Installed copies of the config and ten prompt/goal sidecars live beside the
checkout as `/home/vishvananda/work/v4sol61strands.*`. Keep them in sync with
this example. Ralph state and Strands sessions live outside the private
volume under `/home/vishvananda/work/.ralph`.

Strands uses the existing ChatGPT-authenticated Codex login and supplies shell,
read, write, edit, and web-fetch tools. Ralph supplies portable loop goals,
external checks, and checkpoint audits. Each turn starts a fresh thread.
The config has no `stopAfterStage` limit and continues through PA34, subject
to the normal required checks and `maxTurns: 500` guard.

Start the prepared run from the Ralph repository:

```sh
RALPH_CONFIG=/home/vishvananda/work/v4sol61strands.config.json npm run ralph
```

Its state path is
`/home/vishvananda/work/.ralph/v4sol61strands-gpt-6.1-sol-high`.
Create `stop-after-turn` there to stop after the current turn and its checks.
Scaffolding leaves this run ready to launch with fresh state.

Pricing estimates use $2 input, $10 output, and $0.10 cached input per million
tokens, as supplied by the user.

The retired v4unreal, v4luna, and v4strands working volumes are preserved in
`/mnt/vizier/archives/v4-luna-harnesses-20260929T173701Z`. Each archive contains the complete private write root, including
Git history, uncommitted/untracked files, generated outputs, and scratch,
plus copies of the installed configuration, logs, and Ralph state. The live
Ralph state directories remain in place for viewing historical runs.
