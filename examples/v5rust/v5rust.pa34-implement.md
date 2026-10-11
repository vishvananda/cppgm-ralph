Implement the next coherent PA34 cross-implementation bootstrap fix.

{{briefState}}
Results: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read CLONE_CONTRACT.md's PA34 proof, docs/rust-clone-plan.md and the frozen
C++ pa34/Makefile. R is the Rust-implemented C++ compiler built by rustc. S is
the unchanged original C++ source. H(S)=C0; C0(S)=C1; C1(S)=C2; R(S)=CR;
CR(S)=C3. The requirement is C1==C2==CR==C3 for each object and all nine C++
tools. R's executable need not equal a C++ binary and R does not compile Rust.

Use make test-pa34 for object/tool progress and make inception for the clean
final proof. Group differing objects by their earliest divergent boundary:
tokens, syntax, semantics, ABI, typed LowIR, optimization, MIR, encoding or ELF
layout. Reduce the mismatch to its earliest owning fixture lane and fix the
Rust phase. Preserve all earlier assignments and already matching objects.
Consult the C++ implementation directly; no new code-generation policies.

Maintain identical logical source/include/output paths, generated headers,
default object-root macros, host compiler/libraries/link order and -O3 flags.
Every Rust generation must compile its own objects from clean outputs. Never
reuse C++ objects, strip metadata, normalize binary bytes or alter S to pass.
The protected bootstrap recipe owns the comparison and source inventory.

Finish a coherent fix group, run Rust quality checks and relevant regressions,
update docs/port/pa34.md with exact object IDs, first mismatches, artifact paths
and next dependency boundary, commit and leave the checkout clean. Partial
object-level progress can complete this implementation handoff. Full equality
and rebuilt test ladders are mandatory for the final audit. PA35 is excluded.

Complete Ralph's existing phase goal, then return validation and remaining
work. Do not create/reset the goal or edit checker/Ralph state.

{{modelValidation}}
