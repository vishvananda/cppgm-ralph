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

Layering rule: if `../dev/cppgm++` and a `*-self` compiler behave differently
on the same compile command, first assume the `*-self` compiler may have been
miscompiled. Save the exact command, compare host-seeded vs self-built behavior,
and trace the divergence back to the self-built object/source/compiler feature
that produced the bad compiler. A stack trace inside `*-self` shows where the
bad program failed; it does not by itself prove that stack frame owns the fix.

Behavior includes severe performance divergence. Self-built compilers will be
slower, but if a `*-self` or `*-inception` compile is more than about 5x slower
than host-seeded `../dev/cppgm++` on the same source, or times out while the
host-seeded compiler completes, treat that as layer divergence to trace through
the self compiler build.

Do not make a source-level performance edit from a `*-self` profile alone.
Before editing a hot source path for a self-only slowdown, record in
`pa39/plan.md` one host-vs-self artifact comparison: output diff, generated
object/disassembly diff for the same function, or emitted LowIR/backend trace
diff for the same source. Expect self-built code to have less optimized local
instructions than host compiler output. The PA39 signal is behavioral or
algorithmic divergence: different output, LowIR control flow, EH/unwind path,
branch, loop, call, or data-structure operation that makes the self-built
compiler do substantially different work. Trace that divergence back to the
earlier compiler feature that introduced it.
Do not fix PA39 by rewriting valid compiler source just to avoid a C++ pattern
that `*-self` handles badly. If host-seeded `../dev/cppgm++` handles the source
correctly but `*-self` chooses a bad branch, call, overload, loop, or
data-structure operation, add a reducer for that pattern and fix the earlier
compiler bug instead. Only keep the source rewrite if the source is wrong or too
slow under host-seeded `../dev/cppgm++` too.

Implementation bar:
- Keep `make test-report-through-pa38` passing.
- Use `make -C pa39 test-through-pa10 CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++`
  to debug the self-built checkpoint ladder; use `probe-self-object` and
  `probe-self-link` only as scratch single-file probes.
- Use `make -C pa39 compare-pptoken-inception CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++`
  as the first reproducibility compare before the full compiler compare.
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
