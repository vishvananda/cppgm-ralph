# Compile-Time-First C++11 Compiler Architecture

## Purpose

This specification defines the production architecture for a self-contained
Linux x86-64 C++11 compiler developed cumulatively through V5 PA1–PA35.
It is normative for this run; the assignment handouts define the language, ABI,
fixtures and canonical exit commands. Apply architecture requirements to the
capabilities introduced so far; preserve later boundaries without implementing
later-stage features early. Read each handout’s design and scale guidance before
inventing another protocol or representation.

Compile-time performance is a property of semantic design, not a mode that may
skip required language or ABI behavior. Every required result must be produced
by the compiler's own front end, semantic engine, lowering pipeline, backend,
and object writer.

The requirements state properties, not shapes. Where a requirement names a
structure, the structure is an example of one way to meet the property;
another structure that meets it equally well is just as conforming.

## Production pipeline

The source-to-object path MUST be one in-process pipeline in which each phase
consumes the typed results of the phases before it:

```text
source buffers
    -> preprocessor delivering tokens on demand
    -> parser building one syntax tree for the unit
    -> semantic analysis recording typed facts for that tree
    -> typed LowIR, lowered on demand
    -> LowIR optimization (at -O1 and above)
    -> per-function machine IR
    -> direct ELF object writer
```

A later phase MAY ask an earlier one for work the language defers until it is
needed, such as instantiating a template or completing a class, through that
phase's typed interface. It MUST NOT re-derive an earlier phase's results
from text.

Textual token, syntax-tree, LowIR, assembly, and diagnostic forms are views or
tool outputs. They MUST NOT be transport formats between production phases.

The compiler MAY expose preprocessing, token, syntax, semantic, LowIR, and
machine-code tools. Each tool MUST run the shared phases, stopping at or
rendering a view of the one it reports. Tool requirements MUST NOT force the
object compiler to build a representation that only a tool reads.

## 1. Source, preprocessing, and parsing

- Source files MUST be read in bulk and retained as immutable byte buffers
  with compact file and offset identities. A source location SHOULD be one
  offset in a single location space that covers every file; line and column
  are worked out only when a diagnostic or a debug location needs them.
  Tokens and nodes SHOULD refer to source text rather than copying spellings.
- The lexer MUST NOT build a record per source character. Translation phases
  1 and 2 (trigraphs, universal-character-names, line splices) SHOULD apply
  only where the bytes need them, with ordinary bytes taking a fast path.
- The preprocessor MUST deliver tokens to the parser on demand. No phase may
  materialize the unit's tokens before the next phase starts: ordinary
  compilation MUST NOT build successive owning sequences of preprocessing
  tokens, post-tokens, recognition tokens, and parse tokens. A bounded
  lookahead window, and the compact tokens a deferred language rule needs
  (a member function body parsed after its class), MAY be retained.
- Identifier spellings MUST be interned as they enter the front end. Tokens
  SHOULD carry identifier IDs or interned pointers, not owning strings.
- The unit MUST be parsed into one syntax tree, and no later phase may
  re-parse tokens, source text, or rendered output. Disambiguation MAY
  re-read a bounded region from a checkpoint, or keep the readings an
  ambiguity allows until analysis decides between them; repeated attempts
  SHOULD be memoized so that their cost cannot grow exponentially.
- Template bodies MUST retain their parsed representation. Instantiation
  substitutes and checks nodes and MUST NOT replay the grammar from token
  positions.
- Semantic analysis MUST record its facts for the syntax tree, on its nodes
  or in records the nodes reach directly. The production path MUST NOT copy
  the tree into a second complete semantic tree. The parser MAY track what
  names denote for disambiguation; that is a parsing aid, not a second
  semantic model.
- Source faithfulness MUST come from compact locations and the syntax tree
  itself. It MUST NOT require a parallel owning tree solely for diagnostics
  or rendering.
- Parser checkpoints, for disambiguation or error recovery, MUST have bounded
  scope and MUST NOT clone the token stream or retain abandoned trees.

## 2. Canonical semantic identity

- Identifiers, canonical types, declarations, scopes, specializations,
  layouts, constants, and ABI entities MUST have stable interned pointer or
  compact integer identity. A template argument list is a sequence of such
  identities.
- Equality for canonical types, declarations, specializations, and ABI entities
  MUST be O(1) on the hot path.
- Strings are presentation data. A rendered type, qualified name, or
  signature MUST NOT be the key for semantic equality, lookup, substitution,
  lowering, or invalidation. A mangled name is ABI data: it MAY identify a
  symbol where the ABI makes it the identity (linking translation units, or
  reading LowIR, whose symbols carry their mangled names), but it MUST NOT
  stand in for a fact the compiler holds in typed form.
- Canonical types and other interned identities MUST be immutable once
  published, apart from memos of properties derived from them. State that
  grows as analysis proceeds (a class completing, a specialization's
  definition, a deferred exception specification) SHOULD be explicit on its
  owner, distinguishing not started, in progress, and done, rather than
  inferred from which fields happen to be filled.
- An instantiation refers to the canonical types and declarations it names.
  It MUST NOT duplicate a canonical type or an interned identity.
- Qualifiers, value categories, dependence flags, and source locations SHOULD
  be small values (bit fields, small enumerations, one offset); a qualified
  type MAY be its own interned record. None of them may cause duplicate heap
  records for otherwise identical semantics.
- The facts analysis decides (the selected declaration, each operand's
  conversion, value categories) MUST be recorded once, where later phases
  read them directly. Facts that belong to an entity rather than to one use
  (a class's layout, a function's symbol and ABI entry points) MUST be
  computed once per entity and memoized, whichever phase computes them.

## 3. Scopes, lookup, and overload resolution

- Lookup in a scope MUST be a direct index by scope and interned name (a table
  per scope, or one table keyed by both) that separates the declaration kinds
  the language distinguishes. Lookup MUST visit lexical parents and
  language-required associated scopes without scanning unrelated
  declarations.
- An overload set MUST be reachable from its name's index entry without a
  search. Candidate filtering SHOULD apply cheap checks (arity, default
  arguments, explicit template arguments) before substitution or conversion
  analysis.
- The implementation MUST inspect every candidate required by the language. It
  MUST NOT inspect declarations that cannot belong to the lookup result merely
  because they share a global registry.
- Using-directive, argument-dependent lookup, hidden-friend, and base-class
  relationships MUST have explicit indexed edges. They MUST NOT be rediscovered
  by repeated whole-program searches.
- A completed overload result MUST retain the chosen declaration and conversion
  facts. Lowering MUST NOT rerun lookup or overload resolution; instantiating
  a body that lowering demands is that body's first analysis, not a rerun.
- Expected candidate rejection MUST return a compact result code and optional
  lazy diagnostic. It MUST NOT eagerly render diagnostic strings or use C++
  exception unwinding as ordinary control flow.
- Negative results MAY be cached only when the key contains every semantic
  input that can affect the result. An incomplete key is a correctness defect,
  not a performance optimization.

## 4. Templates and demand

- A specialization key MUST contain the canonical template identity (which,
  for a member template of a class template specialization, identifies the
  enclosing specialization), the canonical arguments, and every context
  component that can change semantic behavior.
- The facts of a specialization (its declaration, its definition, its layout,
  each member's body, default arguments, and exception specification, its
  vtable, and whether it is emitted) MUST be computed separately and on
  demand, so that needing one does not compute the others.
- A fact for one complete key MUST be computed successfully at most once and
  then reused. Its state MUST distinguish at least not started, in progress,
  and done. Recursive demand MUST observe the in-progress state, and report
  the cycle or treat the class as incomplete as the language requires, rather
  than start duplicate work. An expected failure MAY be cached under the rule
  for negative results above.
- Successful results MUST be memoized under a complete key, by an owner whose
  lifetime matches the key. A diagnostic for a failure MAY be rebuilt when
  one is reported; rejected attempts MUST NOT render diagnostic text eagerly.
- Template environments MUST be immutable parent-linked frames or compact
  overlays. Instantiation MUST NOT copy a vector or map of every visible
  binding at each nesting level.
- Substitution MUST operate on checked semantic types, values and dependent
  expressions, preserving required deferred checks. Facts independent of
  arguments and instantiation context MUST be reused, not reconstructed by
  copying and reanalyzing syntax. A demanded body MAY need distinct nodes and
  facts; type and declaration queries MUST NOT force body analysis. Preserve
  definition-time bindings, specialization-specific identities and checks not
  represented in the resulting type. Reads MUST reach instance facts through
  stable identities without per-read searches.
- Only language-required declarations, definitions, layouts, initializers,
  support objects, and bodies may be demanded. Completing a class MUST NOT
  eagerly instantiate unrelated member bodies.
- Parsing a template, completing a class, instantiating a member's body, and
  emitting code are different operations. No operation may invoke a broader
  one merely because the implementation stores them together: completing a
  class does not instantiate its members' bodies, and instantiating a body
  does not emit it.
- Emission MUST be driven by demand: a definition the unit need not emit (an
  inline function, an implicit member, an instantiation) is lowered only when
  something already emitted refers to it, never because its declaration was
  seen. Source order and deterministic output order MUST be separate from
  semantic demand identity.

## 5. Dependency scheduling and caches

- A semantic fact MUST be computed when it is first needed, or pushed through
  an explicit worklist, and reused once computed. Work that can run only
  after a later event (a member waiting for its enclosing class, an access
  check waiting for a friend declaration) MUST be queued on that event, not
  retried by polling.
- Queued work MUST be keyed by stable entity/fact identity and deduplicated.
- Adding or restoring one fact MUST NOT trigger a retry of every pending class,
  function, specialization, or declaration.
- Each cache MUST have an explicit owner, a complete typed key, and a lifetime
  no broader than that key, and MUST document which events (declaring a name,
  completing a class, finishing a substitution) can invalidate its entries.
- Invalidation MUST be limited to what changed, at least to the name or entity
  concerned. A local mutation MUST NOT clear unrelated translation-unit caches
  or increment a global generation that makes every lookup cold.
- Cycles MUST be detected by explicit in-progress states and resolved as the
  language specifies. Retry-until-nothing-changes loops over the complete
  program are forbidden.
- Deterministic output MUST be obtained by stable IDs, source ordinals, or a
  final ordering step. Hot semantic containers MUST NOT be ordered trees solely
  to make incidental iteration deterministic.

## 6. Typed lowering

- Lowering MUST construct typed LowIR objects directly from recorded semantic
  facts. The normal source-to-object path MUST NOT serialize and reparse LowIR.
- A textual LowIR parser and serializer MAY exist for staged tools, debugging,
  and explicit LowIR input/output. They MUST be adapters around the typed model,
  not the model used to communicate between in-process phases.
- Every fact of the in-memory LowIR that a later phase relies on MUST have a
  text spelling, so that a program compiled from its emitted LowIR equals the
  program compiled directly.
- LowIR's structural rules MUST be checked by one validator. Explicit LowIR
  input always passes through it, and audit builds MAY run it after every
  pass.
- Every emitted function, variable initializer, support object, thunk, and ABI
  entry point MUST have a stable emission identity and MUST be lowered at most
  once. Distinct ABI entry points are distinct symbols even when one is
  emitted as an alias of another's body.
- Lowering MUST consume the declarations, conversions, and value categories
  analysis chose, and the layouts it computed, directly. It MAY derive their
  mechanical consequences (the offset along a base path, a vtable's rows,
  which temporaries need cleanups, whether an initializer is constant) from
  the semantic graph. It MUST NOT re-decide what analysis decided, and MUST
  NOT reconstruct a fact from names, type spellings, mangled strings, or a
  second semantic search.
- Lowering MUST NOT clone semantic trees or synthesize nodes for the front end
  to analyze; a short-lived view built to reuse one of lowering's own
  routines is allowed. Lowering-specific state belongs in typed lowering
  records, not in fields added to semantic nodes.
- A missing required semantic fact is an invariant violation. Production code
  MUST NOT contain a slower textual, name-based, or whole-program fallback that
  hides the missing fact.
- Complete-program validation MAY be used for explicit LowIR input and audit
  builds. An unchanged in-memory program MUST NOT be fully revalidated between
  ordinary production passes.

## 7. Backend and object generation

- The default object path MUST use a compact per-function machine IR and direct
  ELF emission. It MUST NOT emit assembly text, parse assembly text, or invoke
  an external assembler.
- Instruction selection, register allocation, local relaxation, and encoding
  SHOULD complete for one function before the next begins, and that
  function's transient state SHOULD then be released or reset for reuse
  (keeping capacity, never contents). At -O0, lowering SHOULD stream each
  function into the backend the same way; an optimizing level keeps the
  unit's LowIR until its interprocedural passes are done.
- Where values that live across blocks are kept MUST be decided by a placement
  policy separate from instruction selection, so that a better allocator
  replaces the policy and not the selector. Machine-IR passes run between
  selection and encoding.
- The default level (-O0) MUST run a small backend: selection, a bounded
  placement policy, and encoding. Each optimizing pass SHOULD document its
  scope and complexity bound.
- Register allocation, instruction selection, and encoding SHOULD be linear or
  near-linear in the selected function.
- Fixed-point iteration MUST make monotonic progress toward a known bound:
  an analysis's lattice height, or a cap on rounds of transforms set by the
  optimization level. It SHOULD be driven by a dirty instruction/block
  worklist, or by rounds that stop when one changes nothing and skip a pass
  that found nothing in a function unchanged since. A transform MUST NOT
  rescan every instruction after each local change.
- Analyses SHOULD be kept at their natural IR unit while that unit is
  unchanged. A function or loop pass MUST NOT recompute a translation-unit
  analysis.
- Whole-program state is permitted only for behavior that crosses functions,
  including linkage/COMDAT decisions, global initialization order, demanded
  symbols, the call graph of interprocedural passes, per-entity facts every
  function shares, and final section/relocation layout, plus scratch buffers
  reused from one function to the next.
- Optimization levels MUST select explicit pass budgets. Expensive global
  transforms MUST NOT be an implicit prerequisite of ordinary object emission.

## 8. Allocation, containers, and lifetimes

- Long-lived front-end nodes MUST use translation-unit arenas or slabs.
  Temporary work (parsing attempts, substitution, overload resolution,
  lowering, and backend scratch) MUST NOT allocate and free per item; it MUST
  be reclaimed in bulk when its query or function ends, by rewinding an arena
  region, reusing containers, or destroying a per-function owner.
- Hot nodes MUST NOT use owning `shared_ptr`, individual `new`/`delete`,
  implicit deep copies, or recursive destruction. Copying a body on purpose
  (instantiating a template, inlining a call) is an operation, not a
  representation cost.
- Variable-size children of immutable data SHOULD be stored compactly
  (trailing arrays, small inline arrays, or slices of an arena or of their
  owner's array). Stable relationships SHOULD use compact IDs or non-owning
  pointers.
- IR that passes rewrite MUST be owned per function and editable in place: an
  optimizer MUST be able to insert, remove, and replace instructions and
  blocks in one function without rebuilding or moving any other function's
  IR, and per-function facts such as use counts MUST be computable from that
  function alone. A program-wide append-only pool of instructions addressed
  by slices does not meet this.
- A fact that the phase owning a node records for every node of its kind
  SHOULD live on the node, or in an array indexed by a dense ordinal. Hash
  tables are for sparse facts, composite keys, and a later phase's state about
  an earlier phase's entities. Dominant maps and sets MUST be keyed by compact
  identity and MUST NOT allocate per entry. Ordered node-based containers are
  allowed only when observable ordering requires them and the cost is
  isolated from hot lookup.
- Temporary collections SHOULD avoid a heap allocation per use, by keeping the
  small case inline or reusing a buffer. Large collections MUST grow
  geometrically and MUST NOT repeatedly copy their full contents.
- Ownership boundaries MUST be explicit for source buffers, retained template
  patterns, semantic facts, typed LowIR, machine IR, and ELF buffers.
- After lowering, the boundary MUST be typed LowIR alone: the optimizer and
  backend hold no pointer into the front end. Data crossing any boundary MUST
  NOT be an owning pointer into a phase that should otherwise be dead.
- No representation may outlive its last consumer. The token stream is a
  bounded window, never the whole unit; there is no second whole-unit copy of
  the syntax (an instantiation's copy of a template body is part of the
  analysis, not a duplicate); textual LowIR is absent from production;
  machine IR exists for one function at a time; and a function's LowIR is
  released once it is encoded. At -O0 the front end stays alive while each
  function streams through lowering and the backend; an optimizing level
  releases the front end before it optimizes the unit's LowIR.
- Process-global state MUST NOT carry results from one translation unit or
  function to another. Global tables are read-only, bounded compiler
  metadata; a scratch buffer reused across functions keeps only its capacity.

## 9. Complexity and observability

- Preprocessing MUST be near-linear in source bytes plus produced expansion
  tokens, apart from work intrinsic to producing repeated macro expansions.
- Parsing MUST be linear in the tokens produced, apart from the bounded,
  memoized re-reading that disambiguation needs.
- Semantic work MUST be proportional to declarations actually introduced,
  candidates actually belonging to lookup sets, demanded specialization facts,
  and dependency edges. It MUST NOT be proportional to Cartesian products of
  unrelated global collections.
- Canonical identity comparison MUST be O(1), and completed-fact lookup O(1)
  on average. These are floors, not designs: a fact that every node of a kind
  carries is read from the node, not looked up.
- Typed lowering, ordinary optimization, machine selection, allocation, and
  object writing SHOULD be O(n) or O(n log n) in the IR they consume. A broader
  bound SHOULD have a documented language or ABI reason.
- Release builds MUST expose low-overhead counters and timers: phase times,
  peak memory, IR sizes, and counts of the work of performance-sensitive
  subsystems (overload resolutions and candidates, specializations and
  instantiations, constant evaluations, optimizer changes, and register
  placement outcomes).
- Telemetry MUST observe existing work rather than introduce alternate semantic
  behavior. Its overhead MUST be separable from ordinary compilation.
- Work counters SHOULD distinguish shared pattern work, newly demanded facts
  and reuse. Proportional growth alone does not establish necessary work.

## 10. Self-contained implementation

- Required output MUST be produced entirely by this compiler. It MUST NOT invoke
  an external compiler, previous compiler stage, reference implementation, or
  cached answer to implement preprocessing, semantics, lowering, code
  generation, or object writing.
- The implementation MUST NOT recognize particular filenames, source text,
  tests, or expected outputs. It MAY recognize by name only the library
  entities the core language itself names (such as `std::initializer_list`,
  `std::type_info`, `std::bad_alloc`, and the replaceable allocation
  functions) and names the standard reserves for the C library.
- Library and language behavior MUST arise from general semantic and ABI rules.
  A shortcut keyed on a library type's name that stands in for a general rule
  is forbidden, even when a particular header makes it appear reliable.
- Optional persistent caches, precompiled headers, modules, or daemon modes MAY
  be designed later. Correctness and the architecture above MUST NOT depend on
  them.

## 11. Performance work and acceptance

Correctness and bounded work matter from the first implementation. Performance
measurement answers a stated question; it is not a recurring whole-stage
campaign. Maintain a small fixed set of checked, representative inputs for
supported capabilities, replacing redundant cases rather than accumulating
variants. Personal controls live in `student.tests/` and run explicitly.

- Validate changed owners with focused correctness and work/reuse controls.
  Choose scales that distinguish new required work from repeated shared work;
  linear growth alone is insufficient. Inspect counters or profile demonstrated
  excess, including expensive linear work. Shared helpers need representative
  consumer smokes, not every historical benchmark.
- Measure affected families after a coherent change is stable. Record the
  hypothesis, frozen binary/input hashes, flags, machine/toolchain, environment,
  affinity, output qualification, raw observations and a compact result link.
  A new or changed matrix must qualify all its inputs before any timing begins;
  nonportable/reference-only controls stay outside host-comparable matrices.
- Measurement tools must reuse valid qualification and unchanged host/baseline
  results by those keys. Invalidate only results whose binary, input, protocol
  or conditions changed. Documentation edits do not invalidate binaries. Do not
  rebuild or remeasure an identical variant merely to rename a report. Retain
  failures and provenance; never treat an unavailable observation as zero.
- For focused native diagnostics, use a warmup and three interleaved runs per
  variant on the same allowed CPU. Group `instructions:u,cycles:u` with perf;
  retain IPC, latency, user/system time, RSS and relevant text size. Check 100%
  event running inside Bubblewrap and the memory scope. Extra repetitions or
  branch/cache/sampling passes require a stated uncertainty or owner question.
  Small timing/cycle claims need fresh paired observations and noise calibration.
  Do not multiply ABBA blocks by default. These defaults never replace a course
  script's fixed protocol, repeat count, simulation or acceptance limit.
- Compare equivalent stage-supported work. Host preprocessing and a typed token
  dump have different output costs; state that boundary rather than demanding
  parity on unlike work. A high rank alone is not a defect. Fix demonstrated
  repeated work, disproportionate cost or a required gate failure; otherwise
  record the result and continue implementation. Deferred later-stage code
  quality belongs to its owning assignment.
- Separate compiler speed from generated-code quality. Use V5's supplied PA35
  speed/scaling/profile, cached quick checks and constant-work A/B tools before
  designing custom measurement infrastructure. For a codegen claim, compile one
  frozen source with old/new compilers; rewriting that source changes the work.
  Keep host/seed/self flags, allocator, link lines and workloads comparable.
- Final audits review complete stage-supported architecture and correctness,
  but run only missing or invalidated focused measurements. A change in binary
  hash does not justify rerunning unrelated host data or expanding coverage.
  Consolidate evidence once after fixes stabilize. Refresh canonical acceptance
  gates on final code; planning targets cannot waive a course limit.

PA1–PA33 finish with the root through report and the shipped file audit over
`dev`. PA34 finishes with its self-test ladder and canonical inception, with
focused divergence diagnosis during iteration. PA35 follows its handout's order:
correctness and workload support, compiler speed/scaling, generated code, then
compiler-speed improvements with unchanged generated code. Run its smoke check
following optimizer/backend changes and its prescribed generated-seed checks
for allocator/MIR changes. Full cache simulation is a final-gate or specifically
justified diagnostic, not a routine handoff task.

PA35 completion is the unmodified `make -C pa35 test` (17 gates), with earlier
through-PA33 and inception checks still passing. `test-progress` reads saved
rungs; it runs no measurements and cannot certify a changed compiler. Partial
handoffs refresh the changed gate group and record current binary/source hashes;
unchanged group measurements may be retained only with valid provenance. Do not
edit gate limits, workload manifests, fixtures, timestamps or measurements to
manufacture progress. The V4 supplemental PA33/PA34 instruction checker is not
part of this V5 run; V5 owns its optimization and kernel limits in PA35.

## Architecture review

Trace a supported declaration or demanded template through its typed consumers.
Cite owners, lifetimes, complete keys and what is reused across distinct demands;
justify newly computed facts. Check direct reads, precise invalidation, editable
per-function IR and release at the last consumer. Fix repeated analysis, text
round trips, global retries and hot per-node allocation. Review later phases as
interfaces, not implemented capabilities. Keep decisions, unresolved groups and
evidence in one compact ledger; old reports are evidence, not instructions.
