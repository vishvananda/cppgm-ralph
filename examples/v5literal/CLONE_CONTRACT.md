# Literal Rust clone contract

Implement all nine frozen C++ tools in Rust by direct source translation.
The installed `scripts/clone/manifest.json` pins the C++ source, assignment
fixtures, reference tools, checker and Rust lint policy. Read source freely at
the reference path in `scripts/clone/settings.json`; never use its implementation
or objects to satisfy a candidate computation. Preserve NOTICE and attribution.

## Translation

`port/inventory.json` freezes every C++ `.cpp`/`.h`, its content hash, function
definitions and mapped Rust file. Translate original algorithms, function/class
boundaries, fields, state lifetimes, lazy demands, short circuits, queue order,
cache keys, failures and target arithmetic. Syntax and representation adaptations
required by Rust need a reason in the owning review. Defer optional redesign,
abstraction changes, file consolidation and optimization until complete parity.
Do not copy or consult another Rust solution.

The source inventory, not the course assignments, orders implementation. Ralph
uses PA33 as the whole-source translation stage and PA34 for bootstrap. This
does not imply that PA1–PA32 have passed. Their original fixtures remain validation
inputs and must all pass before final acceptance. Tool entry points live under
`dev/bin/`, mapped files under `dev/src/translated/`, and necessary shared Rust
representation support under `dev/src/compat/`. Register actual production code
in the library; declarations, empty files and stubs remain pending.

Unsafe is allowed for narrow representation/operation adaptations. Each unsafe
construct needs a SAFETY explanation and exact review entry in `port/unsafe.json`.
Explain allocation ownership, validity, aliasing and lifetime; do not create Rust
undefined behavior to imitate C++ pointers. Preserve original logical lifetimes.
No C++ implementation FFI, subprocess implementation fallback, fixture matching,
embedded reference outputs or output normalization. Original documented host
configuration/link operations remain legitimate; compiler inputs are compiled
by the Rust implementation itself.

## Correspondence and quality

`port/source-map.tsv` retains one row per frozen source. A `complete` row
requires its exact mapped path, whole-file review in `port/reviews/`, every frozen
function mapped to a distinct real Rust function, current Rust hash, declaration/
state review and hashed successful validation evidence. Relevant dependent changes
require renewed review. Checker presence and counts cannot prove semantic identity;
source review and differential tests remain mandatory.

Use `make inspect SOURCE=dev/path.cpp` to inspect source/function identities.
`make build`, `make lint` and `make audit-rust` check production compilation,
formatting, Rust correctness, source correspondence and unsafe records. Existing
file-size, function-length, naming and pedantic style rules are not acceptance
requirements when they would force a rewrite. Do not suppress correctness or
unsafe-documentation checks. New compiler dependencies require a documented
translation reason and feature review; begin with the standard library.

Native goals describe bounded translation/review handoffs. A partial handoff can
finish while the source inventory is incomplete. Complete original mechanisms,
not an arbitrary fixture count. Keep one current ledger, commit coherent work,
leave clean and retain raw evidence. Do not edit protected policy or Ralph state.

## Exact validation

The original protected differential adapter compares candidate and oracle exit,
stdout, stderr and compiler-generated artifacts at identical logical paths.
Diagnostic spelling/order, integer overflow, floating bits, symbols, relocations,
MIR and ELF bytes are observable. A panic, signal, timeout or scaffold exit 86
is never a matching rejection. Course make targets must also report no failed
counts or `.test_failed` markers even if their outer command exits zero.

Only the adapter's explicitly recognized numeric time, RSS and reserved-storage
statistics are excluded; deterministic work counters, field names and all normal
output remain exact. Native exhaustion is not a language result: only the exact
guard diagnostic can invoke the existing bounded 16/32/64 MiB stack qualification,
which requires both compilers to succeed with identical observable results and
retains all attempts. Do not calibrate frame depths or rejection positions.

Use focused cases during translation. Record usable tool/course milestones in
`port/milestones.json`; keep previously passing milestones green. All 33 stages
become mandatory at final closure regardless of the recorded readiness list.
Protected prior/quality successes can be reused only with identical content-bound
inputs and intact raw evidence. Source/checker/fixture/tool changes invalidate
reuse; failures are not reusable. A bootstrap probe is diagnostic only.

## Final proof

For frozen C++ sources S, host compiler H and rustc-built Rust compiler R:

```
H(S) -> C0; C0(S) -> C1; C1(S) -> C2; R(S) -> CR; CR(S) -> C3
Require C1 == C2 == CR == C3 for every object and all nine C++ tools.
```

Use identical paths, generated headers, flags, host libraries and link recipes.
Each generation compiles clean objects. R does not compile Rust, and its own
executable bytes are not compared to C++. Rebuilt course/debug suites remain
required. Full inventory, original PA1–PA33 comparisons/courses/debug, Rust
quality and this bootstrap proof are all mandatory. PA35 is outside this run.
