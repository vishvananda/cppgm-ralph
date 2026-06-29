Ralph loop {{turnNumber}} implementation phase for {{runName}}.

Complete PA39 inception as the final reproducibility increment of the existing
compiler. Create or update `pa39/plan.md` before substantial implementation.

Completion criteria:
- The implementation builds the real self-hosting/inception behavior and
  preserves PA1 through PA38.
- PA39 failures are fixed as real compiler or reproducibility bugs in the
  earliest owning compiler surface, with focused reducers added when applicable.
- No self-hosting shortcuts, generated source-set scans, dummy outputs,
  interpreter/VM/trampoline/template-binary or embedded-payload substitutes,
  fixture/test-specific gates, timeout or OOM workarounds, harness weakening, or
  hardcoded expected behavior are used.
- Scoped or probe runs may be used for diagnosis, but failures found by required
  PA39 checkpoints are blockers for this turn.
- File-size, file-audit, architecture, and reproducibility requirements are
  satisfied in substance.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed as cohesive progress commits.
- `git status --short` is empty before handing control back.
