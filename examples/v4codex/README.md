# V4 Codex run

This scaffold follows v3codex's spec-aware implementation, checkpoint audit,
and final audit phases, using `gpt-6-astra` with `xhigh` reasoning. Each turn
starts a fresh thread under the same bubblewrap isolation settings.

The prepared checkout is `/home/vishvananda/work/v4codex`, based on
`cppgm-assignments` commit `05cab5a6c54d3c07cc31cbdb16196d060ed32c5f`
(V4, PA1–PA34). Its file audit is copied from v3codex; the revised `spec.md`
covers compiler latency, peak memory, generated runtime and code size, with
bounded optimization and controlled performance evidence beyond course tests.
The handouts, fixtures and starter implementation remain the V4 versions.
Personal tests go in `student.tests/` and are run explicitly.

The config and all ten prompt/goal sidecars must have the same filename stem.
Installed copies live beside the checkout as `/home/vishvananda/work/v4codex.*`.
Keep these versioned examples in sync when editing the installed copies.

Start from the Ralph repository:

```sh
RALPH_CONFIG=/home/vishvananda/work/v4codex.config.json npm run ralph
```

State is created on first launch at
`/home/vishvananda/work/.ralph/v4codex-gpt-6-astra-xhigh`.
Scaffolding does not start the run or reuse an older run's state.

PA1–PA33 use `make test-paN` for current-stage progress and the preceding
through report for regression checks. PA34 is explicitly included despite
being marked experimental by the root Makefile. Its ordered required checks
are the host PA1–PA33 report, self-built PA1–PA5 ladder (through AST, the V4
counterpart of V3's PA10 rung), pptoken inception, and root `make inception`.
The final implementation and audit both require the complete inception chain.

Implementation turns expand into related behavior groups while their shared
context remains useful; commits and minimum test progress do not end a turn.
Incomplete handoffs must finish a coherent group and justify their stopping
boundary. The numerical failure-reduction guard remains a minimum safeguard.
`checkpointPhaseEvery: 3` batches audits across three accepted incomplete
handoffs. Each audit covers all changes since the plan's `Last reviewed commit`
(initially `Stage base commit`), then advances that marker to the validated code
tip before committing its records. Full-stage audit always runs on completion,
including changes remaining in a partially filled batch. Each handoff still
starts a fresh thread; audit batching alone does not enlarge implementation turns.

Astra costs use the shared standard short-context API estimate: $10 input,
$1 cached input, and $50 output per million tokens, from the
[OpenAI pricing page](https://developers.openai.com/api/docs/pricing).
Provider-reported costs take precedence. As with existing model estimates,
these rates do not model Fast mode, long-context premiums, or cache-write fees.
