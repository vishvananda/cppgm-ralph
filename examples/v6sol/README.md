# V6 Sol student compiler scaffold

`v6sol` matches [v6opus](../v6opus/README.md), using native Codex
`gpt-6.1-sol` with `high` reasoning instead of Claude Opus. It starts before
PA1 from assignments tag `v6`, commit
`20df0087fc72097316d9ac319b1aaad52593fa1b`, and ends after the PA35 audit.
No compiler implementation, plans, audits or Ralph state are inherited.

The specification is byte-identical to Opus's. The checks, four phases,
checkpoint cadence, PA35 restructure policy, 500-turn limit and resource limits
also match. Only run paths, model/provider settings and native-goal instructions
differ. Codex completes Ralph's existing phase goal with `update_goal`; partial
handoffs end a turn, while Ralph checks assignment acceptance independently.
The 18 sidecars retain semantic-reuse and generated-code guidance, focused
measurements and the course's original acceptance limits.

The scaffold uses the default Codex profile, a dedicated 100 GiB filesystem
and ordinary Bubblewrap storage isolation with a 64 GiB/no-swap memory scope.
Host paths remain readable. There is no copied credential set or custom home.
`assignmentLayout: "v5"` is Ralph's existing PA1–PA35 map, also used by V6.

Install once from `cppgm-ralph`:

```sh
bash examples/v6sol/install.sh
```

The installer refuses existing destinations, provisions only a new volume,
adds the spec as one preparation commit, and creates the private
`vishvananda/cppgm-run-v6sol` repository. Verification checks config/spec parity,
initial PA1 failures, file audit, counters/sampling and a trivial native Codex
goal inside the actual sandbox. That connectivity probe leaves Ralph unstarted.

Launch separately:

```sh
RALPH_CONFIG=/home/vishvananda/work/v6sol.config.json npm run ralph
```

Checkout: `~/work/v6sol`. State: `~/work/.ralph/v6sol-gpt-6.1-sol-high`.
Artifacts: `~/work/private/v6sol/artifacts/scaffold-verification/`.
