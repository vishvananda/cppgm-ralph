Ralph loop {{turnNumber}} implementation for {{runName}}.

Complete a validated implementation handoff for `{{testStage}}`, extending
related behavior groups while the same understanding supports further progress.
This goal ends the implementation turn, not the assignment's independent audit.

Completion criteria:
- Final acceptance includes stage-due controls and the PA33/PA34 1.25x GCC
  instruction gate. Partial handoffs preserve inherited controls; reviews assess
  capability coverage beyond fixture success.
- Reference corrections are allowed with a documented reducer and cited
  standard/contract proof; preserve required behavior, coverage and comparison rules.
- The completed behavior group satisfies current-stage `spec.md`: correctness,
  architecture-audit invariants and host-relative performance evidence using
  repeated `perf stat` instructions/cycles and IPC under the spec's protocol.
- Any incomplete handoff finishes a coherent behavior group and justifies why
  further related work is impractical; meeting the progress minimum is not enough.
- Earlier PAs pass; current failures decrease or reach zero without reduced
  coverage. Adding passing tests alone does not qualify.
- The compact plan and ledger distinguish unfinished implementation from
  independent review questions; neither is waived. Record the handoff boundary
  and preserve review markers.
- File audit and required checks pass:
{{modelValidation}}
- Intended changes are committed; `git status --short` is empty.

When these criteria are met, call `update_goal` with status `complete` and
return a final handoff to Ralph, even if the assignment remains incomplete.
Ralph verifies the handoff and schedules further implementation or audit; audit
must resolve whole-stage findings before advancement.

Codex native goal handling: Ralph creates the goal for this phase. Treat its
objective and every phase instruction as mandatory. Complete the model-owned
phase criteria, then call `update_goal` with status `complete` and return a
concise handoff with validation evidence and any remaining assignment work.
Completing an implementation goal ends this turn even when the assignment is
unfinished; the independent audits still apply. Ralph verifies native goal
completion, reruns external checks, and accepts the handoff before advancing.
Do not wait for Ralph-owned gates, create or replace the goal, or edit Ralph's
goal state files.
