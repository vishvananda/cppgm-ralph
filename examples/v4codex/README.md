# V4 Codex run

This scaffold follows v3codex's spec-aware implementation, checkpoint audit,
and final audit phases, using `gpt-6-astra` with `xhigh` reasoning. Each turn
starts a fresh thread under the same bubblewrap isolation settings.

The prepared checkout is `/home/vishvananda/work/v4codex`, based on
`cppgm-assignments` commit `11be2afc8c6626efdb01a8fa67b390385bbcf474`
(V4, PA1–PA34). Its `spec.md` and `scripts/cppgm_file_audit.pl` are copied from
v3codex. The assignment handouts, fixtures, and starter implementation remain
the V4 versions. Personal tests go in `student.tests/` and are run explicitly.

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

Astra costs use the shared standard short-context API estimate: $10 input,
$1 cached input, and $50 output per million tokens, from the
[OpenAI pricing page](https://developers.openai.com/api/docs/pricing).
Provider-reported costs take precedence. As with existing model estimates,
these rates do not model Fast mode, long-context premiums, or cache-write fees.
