Ralph loop {{turnNumber}} PA34 audit phase for {{runName}}.

Audit PA34 inception against `spec.md` before completing the run.

Completion criteria:
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The final implementation and both inception layers satisfy the spec's
  architecture, performance, observability, and self-containment requirements.
- PA1-PA33 and all required PA34 checks pass reproducibly.
- No layer divergence, PA34-only path, shortcut, nondeterminism, missing
  reducer, timeout/OOM workaround, or file-audit issue remains.
- The plan and audit record final architecture, optimization budgets and the
  spec's controlled compiler latency/memory and executable runtime/text-size
  evidence across generations.
- Required exit criteria pass:
{{modelValidation}}
- Intended changes are committed and `git status --short` is empty.
