# Exact clone contract

Implement all nine C++ compiler tools in idiomatic safe Rust. The oracle is
cppgm-extended commit `905bd7e4412a2d77d88694fe6abc7f3e1c27bce1`, available at
`/home/vishvananda/work/references/v5rust-cpp`. Read its implementation freely;
translate its behavior, including ordering and diagnostic details. Preserve
NOTICE and inherited attribution. The candidate is not a student exercise
whose solution must be discovered without consulting the original.

## Boundaries

The compiler implementation belongs in `dev/src/`. The Rust workspace and
tool entry points are in `dev/`. Use typed module boundaries corresponding to
lex, preprocess, syntax, types, sema, abi, lower, lowir, opt, native, driver and
support. Parse once, consume semantic facts, intern names/types, and use
compact typed IDs and owned stores instead of pointer graphs. No unsafe Rust,
FFI implementation, C++ subprocess fallback, fixture recognition or embedded
reference answers. Standard-library internals are outside the authored-code
unsafe prohibition. Audit any new dependency and its features before use.

Follow Rust naming conventions, not C++ identifier spellings: `snake_case`
modules/functions, `UpperCamelCase` types, `SCREAMING_SNAKE_CASE` constants
and kebab-case packages. Acronyms in types follow word casing (`PpToken`,
`LowIr`, `Mir`). Preserve spellings only where they are observable language,
ABI, file-format or command-line contracts, including the `cppgm++` CLI name.

Keep the C++ source snapshot, fixtures, reference files, protected checker and
baseline manifests unchanged. A reproducible oracle bug or unstable output is
a baseline issue to report, not permission to correct references in this run.
Required new regressions belong in the earliest owning assignment's executed
lane. They supplement the frozen gate and cannot shrink or redefine it.

Read `spec.md`, the owning handout, `docs/rust-clone-plan.md`, the current
stage plan and relevant C++ owners before implementing a behavior group. The
handouts are cumulative coverage requirements, not permission to simplify
the complete compiler. Record each translated responsibility in
`docs/port/source-map.tsv`; one Rust module may replace multiple C++ files.
Avoid mechanically translating one C++ class into one Rust file.

## Validation and progress

`make test-paN` runs the frozen per-case differential gate. `make course-paN`
runs the original assignment's full test target through the Rust adapters.
`make test-report-through-paN` runs completed differential stages. Run focused
cases with `python3 scripts/clone_check.py case paN tests/path.t`.

Every case needs the course outcome plus matching candidate/oracle exit
status, stdout, stderr and compiler-generated artifacts. Reject a panic,
signal, timeout or `EXIT_NOT_IMPLEMENTED` even for a rejection fixture.
The initial scaffolds return 86 to distinguish missing implementation from
normal C++ rejection. Do not replace this with a generic rejection stub.
Diagnostic spelling, ordering, target integer overflow, floating bits,
padding, symbols, relocations, MIR and emitted ELF bytes are observable.
No canonicalization, stripping or equivalent-code substitution proves identity.

Runtime measurements are recorded, not required to be equal: only numeric
`*_ms`, `peak_rss_kb`, arena-storage and peak token-run storage fields on
recognized statistics lines are excluded from byte comparison. Field names,
deterministic counters, normal diagnostics and all generated artifacts remain
strict. Raw statistics remain in invocation evidence.

Recognized formats include `preproc stats`, `lowir stats:`, `abimangle stats:`,
`cppgm++` statistics, `lowiropt_stats` and `lowir2native_stats`. Arena storage
includes bare `arena_bytes` and `name_arena_bytes` as well as the driver phase
fields. This exception never applies to ordinary diagnostic lines.

All course checks must exit successfully and report no failed comparison
counts or `.test_failed` markers; there are no expected-failure exceptions.
PA33's parameter-address control accepts both standalone loads
and loads folded into add memory operands. Its O2/O3 and driver invocations
must all match the oracle bytes. See `docs/port/baseline.md`.

Earlier completed stages stay green. An implementation checkpoint must reduce
failures in the fixed manifest and retain previously passing cases. Added
passing tests do not count as progress. Finish a coherent behavior group,
document the next boundary, commit and leave the checkout clean. Do not stop
after an arbitrary one-test gain when related work remains tractable.

Do not force future-stage capabilities into early-stage gates. Before PA24,
the oracle backend may execute LowIR produced by Rust, as the handout intends;
after PA24 the candidate backend is used. The oracle remains only an evaluator
and comparator, never a substitute for a due candidate tool. Full debug lanes
and implementation-wide checks become release requirements by PA33.

## Rust quality

The workspace forbids unsafe code and denies unused results and unfulfilled
lint expectations. Run `make lint` and `make audit-rust` after changes. Clippy
`all` and `pedantic` warnings fail. Avoid unwrap, expect, panic, todo,
unimplemented, dbg, process::exit and mem::forget in production. Use Result,
typed errors, checked conversions and deliberate target arithmetic. Narrow
lint expectations need a reason; blanket allowances are prohibited.

The Rust file audit supplements Clippy: 3,000 code lines per implementation
file; registered vocabulary/interface modules 2,400, internal model modules
1,800; functions 240, or 360 for cohesive dispatch with at least eight real
match arms; nesting warns beyond six and fails beyond eight. It also checks
mechanical splits, compressed code, duplicates and misplaced environment or
process access. Clippy's length/nesting checks alone are not the file audit.
Do not move logic into macros or generated files to evade it.

Keep environment/configuration reads in `dev/bin/` or build/test boundaries,
outside `dev/src/`, matching the inherited audit. The driver receives typed
options and may perform the documented host-link/environment-query operations.
Compiler phases receive typed options. File I/O is legitimate at
source and object boundaries; process execution to implement a phase is not.
Measure hot-path compile time, memory and scaling on fixed supported inputs.
Record observations without requiring a new generated-code optimization.

## PA34: cross-implementation bootstrap

Let S be the frozen original C++ source, H the real host C++ compiler and R
the rustc-built Rust compiler. Build the following, with the same effective
inputs, source paths, generated headers, flags, host libraries and link recipe:

```text
H(S)  -> C0
C0(S) -> C1
C1(S) -> C2
R(S)  -> CR
CR(S) -> C3

Require C1 == C2 == CR == C3, for every object and all nine C++ tools.
```

R's executable bytes are not compared with a C++ binary. R does not compile
Rust. Stage progress is matching individual source objects, then linked tools
and rebuilt test ladders; the final proof is a clean complete bootstrap.
Keep `CPPGM_HOST_CXX` a real host compiler, explicitly select the selfhost
compiler flavor, and use the same embedded `INCEPTION_OBJ_ROOT_BASE` while
isolating stored generations. Do not substitute an oracle object after a
candidate compilation fails. Do not strip metadata or change optimization
policies to make equality easier. Preserve `-O3` and the original source list.

The final gate repeats Rust debug suites and the ownership census, then runs
PA1-PA33 and PA8/PA32/PA33 debug suites with the rebuilt C++ tools. Both primary
tools and helper compiler/optimizer/backend invocations use that generation.

PA35's GCC instruction budgets and seed/self optimization targets are outside
this clone's objective. Reuse correctness workloads and record Rust throughput
and RSS separately. PA32/PA33 transformations and tie-breaks must still match.
