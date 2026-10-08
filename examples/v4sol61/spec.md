# Fast Compilation and Efficient Generated Code

## Purpose

This specification governs a self-contained Linux x86-64 C++11 compiler.
Correctness is mandatory. Performance has four dimensions: compiler latency,
compiler peak memory, generated-program runtime and generated code size.
Preserve fast frontend processing while making lowering and optimization
produce efficient executables, targeting GCC runtime parity on fixed workloads.
Measure runtime, compilation cost and size separately; fewer IR instructions
are not proof of faster code.

This run evaluates performance beyond the course's completion tests, and every
required behavior is implemented in this compiler's own frontend, semantic
engine, lowering, backend and object writer. Performance never depends on
skipping language or ABI requirements. The host C++ compiler is the yardstick:
on the same input at comparable flags, compile latency, peak memory and emitted
text/object size stay within a small constant factor of the host, and a large or
growing multiple is an architecture defect whether or not tests pass.

## Production pipeline

```text
immutable source buffers
    -> streaming preprocessor and token cursor
    -> integrated parser and semantic construction
    -> canonical typed semantic graph
    -> direct typed LowIR and bounded optimization
    -> per-function machine IR, selection, allocation and final cleanup
    -> direct ELF object writer
```

Textual tokens, syntax, LowIR, MIR, assembly and diagnostics are views or
explicit tool inputs/outputs; they MUST NOT transport data between production
phases. Each staged tool uses the relevant shared phase, and its output needs
MUST NOT force the object compiler to construct unused representations.

## 1. Source, preprocessing and parsing

- Retain immutable source buffers with compact file/offset identities. Tokens
  and nodes SHOULD reference source ranges instead of copying spellings.
- The preprocessor MUST expose a streaming token cursor; retain compact tokens
  only for deferred language behavior, never successive owning token vectors.
- Intern identifiers on entry; tokens carry compact IDs or interned pointers.
  Parse each grammatical source region at most once. Retain parsed template
  bodies; instantiation substitutes and checks dependent nodes without replaying
  grammar. No lexer or parser runs during semantics, instantiation or lowering.
- Parsing and semantic construction MUST cooperate on one typed, source-faithful
  graph; do not build a complete syntax tree and copy it into a semantic tree.
  Preserve source locations and minimal syntax wrappers for rendering.
- Parser checkpoints MUST have bounded scope and MUST NOT clone token streams
  or retain abandoned trees.

## 2. Canonical identity and semantic facts

- Identifiers, types, declarations, scopes, template arguments, specializations,
  layouts, constants and ABI entities MUST have stable interned or compact
  identity. Hot equality and completed-fact lookup MUST be O(1) average time.
- Rendered types, names, signatures, manglings and serialized nodes MUST NOT be
  primary keys for semantic equality, lookup, substitution or invalidation.
- Published semantic nodes and environments SHOULD be immutable, isolating
  language-required mutation in explicit fact/state records. Pack qualifiers,
  value categories, dependence and location data, not duplicate heap nodes.
- Share non-dependent template nodes across instantiations; a specialization
  stores only substituted or newly established facts.
- Record selected declarations, conversions, object identities, lifetime
  actions, layouts, ABI entries and linkage once. Later phases consume these
  facts by identity without reconstructing semantic decisions.

## 3. Lookup and overload resolution

- Index each scope by interned name and relevant declaration kind. Visit only
  lexical parents and language-required associated scopes; never scan unrelated
  declarations or global registries.
- Per-query work is bounded by the scopes and candidates the language requires;
  no lookup, candidate test or instantiation may allocate or scan in proportion
  to the translation unit's total scopes, entities, types or specializations.
- Store compact candidate sequences. Apply semantics-preserving filters for
  arity, declaration kind, member/static category and template shape before
  deduction, substitution and conversion work; then inspect every candidate the
  language requires and record the selection so lowering never repeats it.
- Using-directive, ADL, hidden-friend and base relationships MUST have explicit
  indexed edges, not repeated whole-program searches.
- Expected rejection returns a compact result and lazy structured diagnostics,
  never rendered strings or C++ exceptions. Cache negative results only with
  every input affecting validity; an incomplete key is a correctness defect.

## 4. Templates and demand

- Specialization keys include canonical template identity, arguments,
  substitution environment and every semantic context component. Demand carries
  typed reasons and dependency edges independent of source or output order.
- Maintain separate monotonic states for declaration, definition, layout,
  defaults, exception specifications, member bodies, vtable/RTTI and emission.
  Each fact per complete key is computed once; distinguish not-started,
  in-progress, success and expected failure.
- Recursive demand observes in-progress state instead of duplicating work.
  Memoize success and expected failure at the narrowest correct owner.
- Environments MUST be immutable parent-linked frames or compact overlays; do
  not copy all visible bindings at each instantiation level.
- Transform and recheck dependent nodes only; reuse non-dependent nodes and
  facts. Track semantic demand separately from emission reachability: perform
  required validation even for un-emitted code, preserve ABI/export roots, and
  avoid lowering or emitting unrelated definitions.
- Parsing, substitution, validation, class completion and emission are distinct
  operations. One MUST NOT invoke a broader one merely because they share
  storage; completing a class must not instantiate unrelated member bodies.

## 5. Scheduling and caches

- Propagate facts through a deduplicated worklist keyed by entity/fact identity.
  Record reverse dependencies and enqueue only consumers that can progress.
- Adding or restoring one fact MUST NOT retry every pending item; handle cycles
  with in-progress states and strongly connected dependencies where required.
- Caches MUST have explicit owners, complete typed keys, bounded lifetimes and
  stated validity across insertion, completion, substitution and emission. Local
  mutation MUST NOT clear unrelated caches or make all lookups cold globally.
- Obtain determinism through stable IDs, source ordinals or a final ordering
  step, not ordered hot containers.

## 6. Typed lowering and optimization facts

- Construct typed LowIR directly from semantic facts. Text parsers and writers
  are adapters for explicit tools; production MUST NOT serialize and reparse IR.
- Constructors enforce local validity; typed references make invalid cross-links
  hard to represent. Each function, initializer, thunk, support object and
  distinct ABI entry has one emission identity and is lowered once.
- Consume recorded declarations, conversions, layouts, lifetimes and ABI facts
  through typed lowering records, never through names, manglings, semantic
  searches, cloned semantic trees or fake frontend nodes.
- Preserve proven constants, ranges, alignment, object identity, alias/effect,
  escape, call-target and unwind facts with explicit provenance and validity so
  optimization need not rediscover semantics. Unknown facts remain conservative.
- Missing required semantic facts are invariant violations, never hidden by
  textual, name-based or whole-program recovery. Full validation suits external
  LowIR and audit builds; do not revalidate unchanged in-memory programs.

## 7. Optimization and native code

- Optimize executable work: computation, memory traffic, calls, loops and
  spill/frame costs. From PA24, model uses/defs, call clobbers and revisable
  value locations; at PA26 add precise exceptional edges and unwind constraints.
  Avoid designs that force whole-function spilling around a call or handler.
  PA32 must preserve useful alias/effect facts across serialized LowIR for PA33;
  audit final copies, frames and spills after allocation. Fixtures establish
  outcomes, not a required pass order or allocator.
- Every transform MUST distinguish legality, profitability and work budget.
  Preserve observable effects, aliasing/lifetimes, integer and floating
  semantics, ABI, exceptions and meaningful debug locations. Without a proof or
  budget, retain valid conservative IR.
- Levels select explicit policies: O0 minimizes compiler work; O1 adds cheap
  local simplification and propagation; O2 adds bounded dataflow, loop and
  allocation improvements; O3 permits targeted inlining, specialization,
  versioning or unrolling when expected runtime benefit justifies the cost. No
  level licenses unbounded search or growth or needs a pass whose goal is met.
- Evaluate inlining/dataflow, placement across calls/loops/EH, and final machine
  cleanup as separate capability families, including their interactions. State
  scope, invalidations, pipeline work/growth budgets and measured fallback coverage.
- Fixed-point transforms MUST use dirty instruction/block worklists and a
  progress measure rather than rescanning after each local change. Cache
  analyses at their natural unit and invalidate only affected facts.
- Encoding and O0 selection/allocation MUST be linear or near-linear. Optimized
  selection/allocation may use capped higher-cost analysis with measured benefit.
  Evaluate execution cost and memory traffic, not a prescribed placement scheme.
- Use compact per-function MIR and direct ELF emission; do not emit/reparse
  assembly or invoke an external assembler. MIR views MUST describe the facts
  actually consumed by encoding, frame construction and unwind emission.
- Complete function-local work and release transient state promptly. Retain
  cross-function summaries and bodies only for bounded interprocedural work or
  required linkage, COMDAT, initialization and relocation decisions. Expensive
  global optimization MUST NOT be required for ordinary emission.

## 8. Allocation and lifetimes

- Long-lived frontend nodes use translation-unit arenas or slabs; parser,
  substitution, overload, lowering and backend temporaries use bulk-discarded
  short-lived arenas.
- Hot nodes MUST NOT use owning `shared_ptr`, per-node allocation, deep copies
  or recursive destruction. Variable children use trailing arrays, small inline
  vectors or arena slices; relationships use IDs or non-owning pointers.
- Dominant maps/sets use dense or flat storage keyed by compact identity without
  one allocation per entry. Isolate required observable ordering from hot
  lookup. Grow large collections geometrically.
- Every source buffer, template pattern, semantic fact and IR/object buffer MUST
  have an owner and release point. Cross-phase data is the minimal typed fact
  set, not ownership of an otherwise dead phase.
- Never hold token/syntax graphs, semantic trees, textual IR and function IR
  together; reclaim function-local forms incrementally, and retained
  optimization bodies count against an explicit memory budget.
- Process-global mutable caches are forbidden. Read-only global tables hold
  bounded compiler metadata, not accumulated translation-unit state.

## 9. Complexity and performance evidence

- Preprocessing is proportional to source bytes and produced expansion tokens;
  parsing is proportional to tokens. Semantic work tracks actual declarations,
  candidates, demanded facts and dependency edges, not Cartesian products.
- Lowering, ordinary optimization, selection, allocation and object writing
  MUST be O(n) or O(n log n) in consumed/produced IR. Broader work requires a
  documented language/ABI necessity or a capped higher-level optimization with
  measured runtime benefit, and a bounded conservative fallback.
- Expose low-overhead phase times, peak memory and work counters (allocations,
  candidates, specialization transitions, cache hits, worklist items, functions
  lowered versus emitted, IR sizes). Telemetry never changes semantics; a
  counter exceeding its declared work model or budget is a defect.
- Maintain fixed compiler and executable benchmarks (template-heavy frontend
  work, hosted headers, loops, calls, memory, floating point, self-hosting)
  whose inputs and checked results prevent timing constant-folded or dead work.
- Freeze A/B binaries, flags and inputs; measure compilation and program
  execution separately with repeated per-workload hardware performance-counter
  measurements using the protocol below. Workloads must dominate startup cost;
  keep every observation and report repeat count, spread and host-relative deltas.
- Report retired instructions, CPU cycles and instructions per cycle (IPC),
  compiler latency/peak RSS, executable runtime and text size together
  and check equivalent outputs first. Every compiler table includes the host
  compiler on the same input at matching flags; deltas between builds of this
  compiler do not establish acceptable absolute performance. An optimization
  must show a repeatable benefit on affected workloads, disclose regressions
  elsewhere and stay within the level's documented budgets.
- Profile before optimizing: when a test, benchmark or translation unit is a
  large multiple of the host, dominates suite time or emits disproportionate
  text, record its PMU counts, phase times, work counters and `perf record`
  sampled hot functions, then fix the owning algorithm or data structure.
  Compare equivalent supported work with GCC/Clang and available references;
  use profiles and generated code to distinguish missing capabilities from tuning.

### Hardware-counter measurement protocol

Task-scoped user-mode hardware counting and sampling have been verified inside
this run's Bubblewrap sandbox and systemd memory scope. Use `perf stat` with
`:u` events on the measured command; its default inheritance includes compiler
subprocesses and build workers. Measure compiler and generated-executable work
separately, and keep harness overhead outside focused comparisons. User-mode
events exclude kernel work and off-CPU waiting; retain wall/user/system time
and peak RSS to expose those costs.

- Use `{instructions:u,cycles:u}` as the primary simultaneous event group.
  Gather `{branches:u,branch-misses:u}` and
  `{cache-references:u,cache-misses:u}` in separate passes when investigating
  control-flow or memory costs. Cache event meanings depend on the CPU; record
  the CPU model and exact events, and compare on this same machine.
- Freeze executable/input hashes and flags; use the same allowed CPU affinity,
  cache warmup policy, environment and input for host/A/B (host/seed/self for
  PA34). Pin single-threaded workloads to one allowed CPU with `taskset -c`;
  parallel builds use the same CPU set and `-j`. Collect at least three runs per
  variant, with warmup outside the measured runs; label cold-cache measurements.
  Save each run's raw counts and timing, report median and range, and investigate
  spread that obscures the claimed benefit. Counters are not noise-free.
- Check event time-enabled/time-running and perf's running percentages. Reduce
  event groups or use separate passes when counters are multiplexed; never base
  a small improvement claim on heavily scaled counts. `<not counted>`,
  `<not supported>` and permission errors are missing evidence, never zero.
  Recheck availability inside the sandbox if configuration changes; document
  unavailable events and use supported events plus phase/work telemetry.
- Normalize counts by fixed useful work (input bytes/tokens, functions or
  benchmark iterations) where meaningful. Lower instruction counts expose
  reduced work, but do not by themselves prove lower runtime; explain cycle,
  cache/branch, latency, memory and code-size tradeoffs and preserve correctness.
- For a disproportionate workload use `perf record -e cycles:u -F 99
  --call-graph dwarf,8192 -o <artifact>/perf.data -- <command>` and inspect
  `perf report --stdio`. Verify useful symbols/call stacks and sample quality;
  debug information improves attribution. Keep sampling runs separate from
  comparison runs so profiling overhead does not affect the claimed delta.
  Store reports and profiles under `RALPH_ARTIFACT_DIR` and cite their paths in
  the plan/audit. The sandbox preserves that writable artifact directory.

Example for one frozen single-threaded workload (replace `<cpu>`, `<artifact>`
and `<command>`; use distinct output files for each variant and repeat):

```sh
perf stat -x ';' -o <artifact>/counts.txt -e '{instructions:u,cycles:u}' -- taskset -c <cpu> <command>
```

Command and event semantics are documented in [perf stat](https://man7.org/linux/man-pages/man1/perf-stat.1.html)
and [perf record](https://man7.org/linux/man-pages/man1/perf-record.1.html).

### Stage-scoped performance acceptance

- Apply requirements to the current stage and optimization level; distinguish
  mandated limits from self-selected targets. Harness timeouts and memory caps
  are hang guards, not budgets; §§1-9 are mandatory architecture, and a
  violation is a current-stage defect even when every test passes.
- Activate supplemental checks at their owning PA and retain them thereafter.
  Use behavior and broad cost envelopes; qualify portable C++ cases with GCC
  and Clang. No exact register, opcode sequence, pass, or allocator is required.
  Statistical performance checks report unresolved measurements as inconclusive.
- At PA33 final acceptance, and again at PA34, every workload in
  `student.tests/backend-quality/check_instructions.py` MUST retire at most
  1.25 times GCC user-mode instructions with matching O2/O3 flags and full
  optimization pipelines. Follow its fixed paired-run protocol; missing or
  unstable measurements are non-passing. This run-specific supplement does not
  change the course contract. Earlier PAs measure diagnostically. Neither early
  stopping nor prior-plan target reclassification waives this per-workload limit;
  PA34 whole-self runtime remains a separate measurement.
- Independent audits assess stage-due capabilities beyond these quality floors.
  Early stopping requires representative coverage of each major remaining
  capability family; local failed experiments do not establish that coverage.
- A numeric target that a prior plan invented may be reclassified without
  approval, with evidence and rationale. Preserve all measurements; historical
  misses do not fail a corrected implementation. Inherited plans do not override
  these rules. Never weaken mandated limits, correctness or coverage.

## 10. Self-contained implementation

- Required output MUST come from this compiler. Do not invoke an external or
  reference compiler, previous implementation or cached answer to implement
  preprocessing, semantics, lowering, code generation or object writing. Host
  linking where the assignments require it remains a separate boundary.
- Do not recognize test filenames, source snippets, library type spellings or
  expected answers. Language and library behavior follows general semantic and
  ABI rules, including performance-sensitive cases.
- Persistent caches, precompiled headers, modules and daemon modes may come
  later; correctness and this architecture MUST NOT depend on them.

## Architecture audit

Trace a nontrivial declaration and a demanded template from source to ELF. For
each invariant below, cite the owning `file:function` that upholds it, or record
and fix the violation; prose summaries are not evidence. Any unexplained text
roundtrip, global retry, reconstruction or hot per-node allocation fails.

- One parse per source region; no lexer/parser runs after parsing (§1).
- Compact canonical keys; no rendered text is a lookup or cache key (§2).
- Bounded per-query work; nothing scales with the whole translation unit inside
  a lookup, candidate, instantiation or instruction path (§3, §4, §9).
- Cheap filters before deduction, substitution and conversion (§3).
- Demand-driven instantiation, mangling, lowering and emission (§4, §6).
- Precise worklists, complete cache keys, direct typed lowering and explicit
  allocation/release boundaries (§5, §6, §8).
- Hardware counters, phase timers and work counters consulted on the slowest
  workload, with every trigger sampled, attributed and resolved (§9).

Trace facts through legality, profitability, invalidation and encoding. At
PA24/26 inspect placement and call/EH constraints; at PA32 inlining and memory
dataflow; at PA33 cross-block allocation, scheduling and final cleanup; at PA34
whole-self runtime. Cite representative outcomes and compare alternatives;
passing fixtures alone cannot certify architecture or optimal performance.
