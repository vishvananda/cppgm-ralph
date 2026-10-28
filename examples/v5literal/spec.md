# Source-faithful Rust compiler port

The frozen C++ implementation is the algorithmic specification for this run.
Produce the same nine compiler tools and exact observable results in Rust.
This is a translation experiment. Defer idiomatic restructuring, architectural
improvements and optimization until the full compiler has exact parity.

## Correspondence

Keep one mapped Rust file for every frozen C++ header and implementation file.
Preserve function boundaries, fields, traversal and evaluation order, mutation,
failure behavior and lazy work. Rust keywords, overloads, templates, inheritance
and declarations require representation adaptations; document each adaptation
without replacing the underlying algorithm. Preserve source vocabulary tables.
Do not replace the source pipeline with another implementation of the language.

Map initialization, ownership, aliasing, reset, completion and destruction for
each persistent owner. Temporary Rust borrowing facades may not reset state that
survives in C++. Preserve live queue traversal, one-time unit passes, later direct
demands and exact cache invalidation. Source-level query calls can have effects;
retain their short circuits and ordering even when the returned value is equal.

## Compatibility layer

Establish common representation rules before translating dependent bodies.
Prefer shared pointer/arena, nullable identity, target arithmetic and error
primitives to repeated local adaptations. Unsafe is permitted where necessary
to preserve the reference representation or operations, with a precise safety
argument, source correspondence and review. Raw C++ aliasing does not justify
creating overlapping Rust mutable references or using freed/uninitialized data.
Do not use unsafe to call the existing C++ compiler implementation.

## Work and evidence

The complete frozen source inventory drives progress. Translate in dependency
order, using finite batches for mutually dependent declarations. A source is
complete only when its entire contract is implemented, its function map is
complete, and current Rust bytes and validation evidence are reviewed. Pending
stubs may support compilation but never count as translated responsibilities.

Assignment fixtures, original course/debug lanes, exact output comparison and
the cross-implementation bootstrap validate the result. They do not authorize
rediscovering or simplifying the implementation. Diagnostics, deterministic
work counters and generated files remain exact; measured time/storage follow
the existing comparator's explicit exclusions. No PA35 optimization target.

Style lints or size limits may not force different function/class structure.
Retain formatting, Rust correctness checks, unsafe documentation and the
mechanical-correspondence audit. Final acceptance requires the complete source
inventory, all PA1–PA33 differential/course/debug checks and clean PA34 equality
for every object and all rebuilt tools.
