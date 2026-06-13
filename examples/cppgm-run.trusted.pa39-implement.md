Implement PA39 inception.

State:
{{briefState}}
- test status: {{testStatusSummary}}
- first blocker: {{firstFailureBlocker}}
- full primary log: `{{lastTestLogPath}}`

Before editing, read `AGENTS.md`, `TESTING_AND_REFERENCES.md`,
`pa39/README.md`, `pa39/Makefile`, and `dev/frontend_source_sets.mk`. Create or
update `pa39/plan.md` before substantial implementation; keep it focused on the
first failing checkpoint, the underlying earlier compiler surface, and the
validation plan.

PA39 does not add a new language feature, mode, object format, runtime ABI, or
backend surface. It proves that the existing compiler can rebuild itself
reproducibly. Treat PA39 failures as earlier compiler bugs or reproducibility
bugs until proven otherwise.

Implementation bar:
- Keep `make test-report-through-pa38` passing.
- Use `make -C pa39 test-through-pa10 CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++`
  to debug the self-built checkpoint ladder.
- Final success requires
  `make -C pa39 compare-cppgm++-inception CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++`.
- When a failure reduces to parser, semantic, lowering, optimizer, backend,
  runtime, or ABI behavior, add a focused reducer under the earliest owning
  `cppgm.tests/course/paN` directory and fix the real compiler bug there.
- Do not add self-hosting special cases, replace `frontend_source_sets.mk` with
  generated source discovery, weaken tests, skip work, embed payloads, use an
  interpreter/VM/trampoline/template binary, or work around timeouts.

Required exit criteria:
{{modelValidation}}

The file audit is implemented at `scripts/cppgm_file_audit.pl`. Treat its
findings as design blockers, not text to suppress. Commit cohesive progress and
leave `git status --short` empty before returning.
