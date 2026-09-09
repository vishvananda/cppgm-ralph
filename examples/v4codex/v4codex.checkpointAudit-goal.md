Ralph loop {{turnNumber}} checkpoint audit for {{runName}}.

Audit all `{{testStage}}` changes since the last review against `spec.md`.

Completion criteria:
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The complete accumulated range and its interactions are reviewed; affected
  ownership paths have no unresolved spec, correctness or performance issue.
- Performance claims meet the spec's compiler and applicable executable evidence
  requirements, including optimization legality and work/growth budgets.
- Earlier PAs pass; the latest checkpoint failure count is not exceeded and
  test coverage is not reduced.
- The compact plan and audit record findings, evidence, the reviewed code tip
  as `Last reviewed commit`, and broadly grouped remaining work.
- File audit and required checks pass:
{{modelValidation}}
- Intended changes are committed; `git status --short` is empty.
