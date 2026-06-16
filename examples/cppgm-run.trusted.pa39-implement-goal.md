Ralph loop {{turnNumber}} implementation phase for {{runName}}.

Complete PA39 inception.

Completion criteria:
- `pa39/plan.md` describes the self-hosting failure, the earlier compiler
  surface that owns it, and the validation plan.
- `make test-report-through-pa38` passes.
- `make -C pa39 test-through-pa10 CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++` passes.
- `make -C pa39 compare-pptoken-inception CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++`
  passes.
- `make -C pa39 compare-cppgm++-inception CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++`
  passes.
- File audit passes.
- PA39 failures are fixed as real compiler or reproducibility bugs, with focused
  reducers added to the earliest owning `cppgm.tests/course/paN` directory when
  applicable.
- No self-hosting shortcuts, generated source-set scans, embedded payloads,
  interpreter/VM/trampoline/template-binary substitutes, timeout workarounds,
  fixture gates, or harness weakening are used.
- Intended changes are committed as cohesive progress commits.
- `git status --short` is empty before handing control back.
