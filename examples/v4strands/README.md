# V4 Strands run

This run compares the Strands harness with v4unreal on the same
`gpt-6-luna` model at `max` reasoning effort. It begins at the same clean V4
scaffold commit, `e50e87639`, before PA1 implementation. The checked-in
`spec.md` and `scripts/cppgm_file_audit.pl` have the same hashes as v4unreal.
The PA1–PA34 checks and all ten phase prompt/goal sidecars are copied from
v4unreal. The checkout is backed by
[cppgm-run-v4strands](https://github.com/vishvananda/cppgm-run-v4strands).

The prepared checkout is `/home/vishvananda/work/v4strands`, inside the
dedicated `/home/vishvananda/work/private/v4strands` 20 GiB filesystem. The
installed config and sidecars are `/home/vishvananda/work/v4strands.*`; keep
them in sync with this example. Ralph state and Strands sessions are stored
under `/home/vishvananda/work/.ralph` outside the private write volume.

The backend uses the ChatGPT-authenticated Codex login from `CODEX_HOME` or
`~/.codex/auth.json`; it does not require `OPENAI_API_KEY`. Strands supplies
shell, read, write, edit, and web-fetch tools. Ralph supplies the same
portable goal text and external checks as v4unreal. The transport restores
encrypted reasoning across tool calls within a turn, but Strands' Responses
adapter still drops it when a session resumes in a new process. The direct
Codex transport does not refresh an expired login itself.

To start the run from the Ralph repository:

```sh
RALPH_CONFIG=/home/vishvananda/work/v4strands.config.json npm run ralph
```

Its state path is
`/home/vishvananda/work/.ralph/v4strands-gpt-6-luna-max`.
Create `stop-after-turn` in that directory to stop after the current turn.
