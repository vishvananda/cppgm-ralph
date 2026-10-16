# Rust compiler reference stages

This reviewed extension takes effect after PA33. Earlier stages keep their
original implementation and source-access contract. PA34 uses the @PROFILE@
profile in the updated handout; PA35 optimizes the Rust implementation under
the ordinary course correctness, ABI and quality rules. The frozen C++ source
is a workload: inspect/reduce compilation failures, but never copy its compiler
implementation into the Rust pipeline or delegate production phases to it.

Let S be the owner-pinned C++ bundle, R the actual Cargo release C++ compiler,
B=host(S), A=R(S), C=A(S) and D=C(S). PA34 requires complete clean generations,
C==D, and rebuilt course/debug suites using A and D and their own helpers.
The port profile additionally requires F=B(S) and F==A==C==D. Independent
student codegen need not match the reference's first generation.

PA35 measures R's C++ compile time, RSS and scaling separately from the codegen
quality of A relative to B. Never measure C/D as R's generated code. Keep S,
workloads, flags, allocator and link recipe fixed. Retain old R for constant-
source A/B comparisons. Use focused correctness, cached hardware counts and
canonical group checks during iteration; full simulation and bootstrap belong
to final acceptance or a stated unresolved question. Do not grow benchmark
matrices, requalify unchanged inputs, or treat missing results as zero.

PA35 permits valid optimizer/backend and internal work-counter differences;
the port's exact PA1–PA34 proof remains a recorded milestone. Required course
outputs, ABI/IR facts, earlier correctness, safe Rust architecture, Rust quality
and the file audit remain mandatory. Preserve the published 17 gate limits.

Ralph owns the native phase goal. Complete a coherent implementation handoff
with validated progress, or complete the independent audit only after its full
acceptance. Use update_goal status complete for that handoff; do not create or
replace goals, modify checker/Ralph state, or mark a temporary issue blocked.
