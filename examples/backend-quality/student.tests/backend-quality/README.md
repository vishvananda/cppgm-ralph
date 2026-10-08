# Backend quality fixtures and acceptance gate

The fixtures are ordinary C++11 in `student.tests/pa27/emission-growth` and
`student.tests/pa32/accessor-growth`. Python only builds, runs and measures them.
These regression controls run separately from the course test runner. All four
historically measured compilers pass the earlier growth controls; those controls
do not establish progress beyond those compilers or gate GCC runtime parity.
The native `v4sol61` and `v4svelte` configs separately require the PA33/PA34
instruction gate described below. Historical qualification results describe
the tested compiler binaries, not the current progress of either run.

The later [PMU samples](perf-samples.md) compare complete optimized pipelines
at PA33 and frozen self-compilation at PA34. Based on those results, the
PA33 gate now requires **at most 1.25x GCC retired instructions on every kernel**,
inherited at PA34. The two CPPGM implementations in the historical qualification
fail this gate.

## PA33 instruction gate

Run from the repository root:

```sh
python3 student.tests/backend-quality/check_instructions.py --stage pa33 \
  --compiler ./dev/cppgm++ --cpu 24 --out obj/backend-quality/instruction-gate
```

Replace `--compiler` with `g++`, `clang++` or another candidate to qualify it.
`--gcc` selects the GCC baseline and common host driver/linker (default `g++`).
Use the same GCC build throughout a comparison. The config pins CPU 24
on this host; without `--cpu`, the checker uses the first allowed CPU.

The four cases are the accessor loop with distinct and aliasing pointers at O2,
lookup at O3, and loop state across calls/rare exceptions at O3. These are ordinary
C++11 kernels, compiled with full optimization pipelines, then linked against
the same GCC-built driver without LTO. The driver independently checks results,
final memory and call counts on boundary inputs and the measured input. No
particular allocator, pass order, register, instruction sequence or MIR form is
required. Matching the course's PA32 pipeline in GCC/Clang is unnecessary.

After warmup, three blocks run GCC/candidate/candidate/GCC, giving six measured
runs of each. Each block divides the candidate's mean retired instructions by
GCC's mean. **All three block ratios must be <= 1.25 for every case.** There is
no average across workloads and no substitution of faster cycles for this limit.
All ratios above the limit fail; ratios straddling it are inconclusive. Instruction
spread above 0.5% or zero-iteration overhead above 1% is also inconclusive. These
are fixed repeatability checks, not statistical confidence intervals.

Perf counts user-mode instructions and cycles together on the same pinned CPU.
Missing, unsupported, nonpositive or multiplexed counters cannot pass. All events
must report 100% running. Incorrect results fail before ratios can be accepted.
Exit status is 0 for pass, 1 for failure and 2 for inconclusive; both nonzero
outcomes block the final audit. Each invocation preserves raw CSVs,
commands, hashes, counts, variation and object sizes in a new `run-*` directory.
Compiler, fixture or policy changes during measurement invalidate the result.

PA1–PA32 return `NOT_APPLICABLE` before requiring any compiler or PMU access.
Ralph requires this check only at final audit, outside partial implementation/checkpoint handoffs.
At PA34 it repeats the PA33 kernels using `dev/cppgm++`; the separate whole-self
benchmark remains diagnostic. Course tests, frontend performance requirements
and final inception remain required independently. This is a run-specific
supplement to PA33's course contract, which requires no profiler.

Fresh qualification on 2026-10-03, GCC 15.2 / Clang 22.1, CPU 24:

| Candidate | Accessor, either input | Lookup | Exceptions | Gate |
| --- | ---: | ---: | ---: | --- |
| GCC | 1.000 | 1.000 | 1.000 | PASS |
| Clang | 1.120 | 1.000 | 1.068 | PASS |
| Reference | 1.784 | 2.078 | 2.266 | FAIL |
| v4opt | 3.525 | 2.097 | 2.163 | FAIL |

Each complete invocation took 7–9 seconds including compilation and behavioral
checks. All 192 measured executions produced correct results; counters ran at
100%, instruction spread was below 0.00003%, and startup was below 0.73%.
Reports are under `obj/backend-quality/instruction-qualification/`. Policy
boundary, excessive-noise, missing/multiplexed-counter and pre-PA33 cases were
also checked. Four deliberately wrong-result kernels fail before measurement;
an unavailable CPU at PA34 returns inconclusive with exit 2. This small fixed
suite measures executed work, not general runtime parity; cycles and object
sizes are diagnostic. Expand coverage with ordinary
supported C++ workloads, qualifying GCC and Clang before making additions required.

## Earlier regression fixture contracts

| First stage | Family | Behavior oracle | Proposed maximum growth versus its own flat/base object |
| --- | --- | --- | --- |
| PA27 | Add 0, 64, 256 unused inline definitions | A separate consumer calls an exported function and an explicit template specialization on 257 inputs | 4 KiB executable bytes; 8 KiB allocated bytes |
| PA32 | Add 0, 8, 64 layers of trivial load/store accessors | A separate consumer checks 70 alias/non-alias, loop-count and unsigned-value combinations, final memory and side-effecting call counts | 1 KiB executable bytes; 4 KiB allocated bytes |

PA27 activates at O0. From PA32 onward it also runs at O1/O2/O3. The PA32
accessor envelope applies at O2/O3 and is inherited by PA33/PA34. Earlier stages
return `NOT_APPLICABLE` without requiring a compiler or linker. A PA24 allocator
is therefore never judged against PA32's abstraction-removal requirement.

Both translation units contain defined behavior under the Linux x86-64 C++11
contract. Unsigned arithmetic wraps intentionally. No compiler-specific syntax,
assembly, expected instruction/register sequence or diagnostic counters appear
in the fixtures. The consumer is compiled separately by a fixed host compiler;
only the kernel object is measured, before linking and without LTO or section GC.
Host linking is the PA27 contract and also keeps oracle code out of size deltas.

The checker sums all ELF sections with `SHF_EXECINSTR` for executable bytes and
all `SHF_ALLOC` sections for allocated bytes, including unwind and zero-fill
storage. It does not depend on section names or function partitioning. Complete
object size is reported but not gated, allowing differences in string/symbol
tables. Compiler, host, fixture and policy hashes accompany the actual commands.

The deliberately loose additive allowances permit residual calls, outlining,
different allocation, padding and metadata. They detect substantial retained
work; they are proposed floors, not C++ language requirements, GCC-relative
runtime limits, compiler-memory limits or proof of efficient register allocation.
Passing GCC and Clang is necessary qualification here, not proof of universality.

## Run

From the repo root, qualify GCC and Clang with the identical checks:

```sh
python3 student.tests/backend-quality/check.py --stage pa32 \
  --report obj/backend-quality/qualification.json
python3 student.tests/backend-quality/qualify.py \
  --report obj/backend-quality/negative-controls.json
```

Check another compiler with the same fixtures, host consumer and bounds:

```sh
python3 student.tests/backend-quality/check.py --stage pa32 \
  --compiler candidate=/absolute/path/to/cppgm++ \
  --report obj/backend-quality/candidate.json
```

`--host-cxx` selects the common host compiler/linker. `--compiler NAME=PATH` may
be repeated. A build/run/format error or exceeded envelope returns nonzero.
The 60-second process timeout is a hang guard, never a performance threshold.
These earlier regression checks use no timing, PMU or exact binary equality gates.

The qualification script changes only scratch copies: making unused functions
externally required demonstrates sensitivity to retained code; O0 compilation
demonstrates sensitivity to retained accessor chains. Both controls still pass
behavior. These altered programs are *not* compiler failures or additional
requirements on O0. Separate wrong-result mutations must fail the consumers.

## Qualification observations

GCC 15.2 and Clang 22.1 pass all 18 variants each. The reference and current
`v4opt` CPPGM binaries also pass all 18 variants each (72 builds/runs total).
All four have zero measured growth for the unused-definition family. GCC,
Clang and the reference have zero accessor-chain growth; `v4opt` retains 60
extra executable bytes and 140 allocated bytes at depth 64, which pass.

The retention controls exceed the envelopes: GCC/Clang retain approximately
15.9/16.4 KiB extra executable code for forced definitions and 4.4/3.8 KiB for
unoptimized accessor chains. Wrong-result controls are rejected by both hosts.
Reports are generated under ignored `obj/backend-quality/` and are reproducible
with the commands above. No compiler implementation or course oracle changed.

## Role in acceptance

These controls can protect an existing quality floor during a rewrite. They are
not proposed as an external gate for backend improvement: current `v4opt` passes
while retaining its measured runtime deficit. Tightening the byte allowances to
reject that compiler would not establish a runtime improvement.

The PA33 gate above addresses the measured instruction-count gaps, supplementing
these controls. Passing it demonstrates the fixed instruction budget on these
inputs. Broader and held-out workloads, runtime, compilation cost and frontend
ratios still require independent measurement. Full correctness and
reproducibility requirements remain separate.
