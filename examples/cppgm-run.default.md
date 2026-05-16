You are implementing the next assignment stage of this C++ compiler. Build the
general compiler functionality needed by the assignment. Finish with
`{{testCommand}}` passing, earlier stages preserved, intended changes committed,
and `git status --short` empty.

The architecture and cleanup requirements below are mandatory. Use them to
shape the implementation from the start, not as an optional final polish pass.

Before editing, read:
- `AGENTS.md` for repository rules
- `TESTING_AND_REFERENCES.md` for test and reference policy
- the target `paN/README.md` for the assignment contract
- the full relevant test set for the current stage

Each assignment is one step toward the full compiler. Follow assignment design
guidance, recommended component structure, and future-use notes unless you have
a clear reason not to, and document that reason in `{{testStage}}/plan.md`.

For diagnosis, prefer `make test-report ACTIVE_TEST_REPORT_PAS='{{testStage}}'`
over `make test-{{testStage}}`; it runs the current PA in keep-going mode and
shows the full failure set. Use `{{testCommand}}` as the completion gate.
After meaningful implementation chunks, rerun the full `{{testCommand}}`, not
only the narrowed diagnostic command, so earlier-stage regressions are found
while the cause is still fresh.

Use those sources to determine the required assignment behavior, intended
compiler components, repository boundaries, and reference policy. If they appear
to conflict, preserve the architecture and cleanup requirements while satisfying
the most specific assignment/test contract. Document the interpretation in
`{{testStage}}/plan.md`.

Before substantial implementation, write `{{testStage}}/plan.md` with an
`Architecture Plan` section covering the core data model, component boundaries,
owning files/modules, representation efficiency, and unacceptable shortcuts or
architecture drift.

Architecture requirements:
- You MUST design from the full assignment surface, not one failing test at a
  time. Inspect the relevant tests first, infer the general feature shape, and
  implement a model that can support the whole PA and plausible later PAs.
- You MUST use compact, typed internal data: enums, IDs/handles, spans,
  interned/canonical strings, and vector/arena-backed records where appropriate.
  Avoid duplicated strings, copied subtrees, pointer-heavy graphs, and repeated
  heap allocation unless the design justifies them.
- Text is an input/output boundary, not the compiler's internal source of
  truth. Preserve structure and meaning in stage-appropriate records: tokens for
  lexical stages, macro/preprocessor state for preprocessing, and semantic/type/
  scope/function/object records for later stages. When later logic needs a fact,
  compute and store that fact in the owning model instead of recovering it from
  formatted text, spelling conventions, or previously emitted output.
- You MUST keep interfaces minimal and responsibilities separated: parsing,
  semantic analysis, lowering, optimization, and formatting/output should not
  own each other's invariants unless the PA is too small for that split.
- You MUST fix invariants at the owning layer. Do not compensate in output
  formatting, test-specific branches, or downstream lowering for information
  that should have been represented earlier.
- You MUST avoid repeated global scans, reparsing rendered text, and late
  recovery in hot paths. Prefer cached semantic facts and canonical identities.
- You MUST build a performant compiler implementation. Timeouts or near-timeouts
  on normal tests are architecture signals: revisit the data model, algorithm,
  or overall implementation strategy before adding local hot-path hacks.
- You MUST keep implementation files at or below 1,500 lines and functions at
  or below 120 lines. If code grows too large, refactor and modularize it into
  cohesive components with clear responsibilities and interfaces; do not satisfy
  the limit by mechanically slicing one large implementation into numbered parts
  or include-file fragments.
- You MUST avoid shortcuts, test-specific hacks, hardcoded answers, and
  superficial workarounds. Fix the underlying implementation issue.

After `{{testCommand}}` first passes:
1. Add an `Architecture Review` to `{{testStage}}/plan.md` comparing the
   implementation with the original plan. Identify concrete deviations in data
   model, component boundaries, ownership, performance, and test-driven drift.
2. Perform an architecture pass, not a cosmetic cleanup pass. Refactor the
   implementation so the actual modules, interfaces, and data ownership match
   the plan; address oversized files/functions, duplicated logic, stringly data,
   global scans, tight coupling, or logic in the wrong layer while preserving
   behavior.
3. Specifically inspect the implementation for string representation problems:
   semantic facts encoded in formatted names, delimiter-joined strings, output
   text, spelling conventions, or payload text. Move those facts into typed
   records, symbols, enums, IDs, spans, or canonical tables owned by the stage.
4. Specifically inspect implementation size and shape. If any file or function
   is too large, refactor by responsibility into cohesive modules with clear
   interfaces.
5. Rerun `{{testCommand}}`.
6. Add a `Final Architecture Review` describing the refactors made and confirming
   that the implementation now satisfies the architecture requirements.
7. Make cohesive progress commits. The final commit must include
   `{{testStage}}/plan.md`.

## Status Context

The following status context is a progress summary only. Use it to avoid
repeating work, not as a substitute for reading the assignment contract or
designing the implementation.

{{currentState}}
