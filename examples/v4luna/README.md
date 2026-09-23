# V4 Luna run

This run compares native Codex with v4unreal and v4strands using `gpt-6-luna`
at `max` reasoning effort. It starts from the same clean V4 scaffold commit,
`e50e87639`, with identical `spec.md` and `scripts/cppgm_file_audit.pl`.
The PA1–PA34 checks and phase prompts match the other runs. The goal sidecars
retain `update_goal` because native Codex exposes that tool. The checkout is
backed by [cppgm-run-v4luna](https://github.com/vishvananda/cppgm-run-v4luna).

The checkout is `/home/vishvananda/work/v4luna` in a dedicated 8 GiB filesystem
at `/home/vishvananda/work/private/v4luna`. The installed config and ten
prompt/goal sidecars are `/home/vishvananda/work/v4luna.*`; keep them in sync
with this example. Ralph state and Codex sessions live under
`/home/vishvananda/work/.ralph`, outside the private write volume.

Native Codex uses the existing subscription login and Ralph's native loop goal.
Each turn starts a fresh thread. Ralph runs the same external checks and stops
after the PA7 full-stage audit passes, before PA8 starts. Remove
`"stopAfterStage": "pa7"` from the config to continue beyond that point.

Start or resume from the Ralph repository:

```sh
RALPH_CONFIG=/home/vishvananda/work/v4luna.config.json npm run ralph
```

State is `/home/vishvananda/work/.ralph/v4luna-gpt-6-luna-max`. Create a
`stop-after-turn` file there to stop after the current turn and its checks.
