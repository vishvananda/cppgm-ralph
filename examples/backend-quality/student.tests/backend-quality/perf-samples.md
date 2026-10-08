# Exploratory instruction-count comparisons

Measured 2026-10-03 on the Xeon E5-2696 v4, pinned to CPU 24. These exploratory
samples informed the selected **1.25x GCC per-workload budget** in the
PA33 gate; see [the checker and fresh qualification](README.md#pa33-instruction-gate).
The prompt/spec/config changes were applied on 2026-10-03. All compilers use
their complete O2/O3 pipelines for PA33. Stage names describe measurement boundaries; the reference is
the current completed compiler, not a historical PA snapshot.

| Workload | Flags | GCC | Clang | Reference | Current v4opt |
| --- | --- | ---: | ---: | ---: | ---: |
| PA27 baseline: scalar loop with an external call | O0 | 1.000 | 0.909 | 1.046 | 1.100 |
| PA33: 64 accessor layers, distinct pointers, external calls | O2 | 1.000 | 1.120 | 1.784 | 3.525 |
| PA33: same loop with aliasing pointers | O2 | 1.000 | 1.120 | 1.784 | 3.525 |
| PA33: open-addressed lookup, hits and misses | O3 | 1.000 | 1.000 | 2.078 | 2.097 |
| PA33: loop state across calls and rare exceptions | O3 | 1.000 | 1.068 | 2.266 | 2.163 |

Each value is retired user-mode instructions divided by GCC's count for the
same source, input and optimization level. GCC is 15.2; Clang is 22.1. The
reference executable hash begins `61b81983a980`; v4opt begins `b140dbba6613`.
Full paths, hashes, source hashes, commands, counts and binary sizes are in
`obj/backend-quality/pa33-samples/results.json`, with raw perf CSVs alongside it.

For PA34, the already-built seed/self compilers process the frozen O0 compile
workload. This compares each compiler's self-built binary against its own
GCC-built binary; it does not compare different frontend implementations:

| Compiler family | Seed instructions | Self instructions | Self / seed |
| --- | ---: | ---: | ---: |
| Reference | 11.360 billion | 19.157 billion | 1.686 |
| Current v4opt | 11.679 billion | 32.057 billion | 2.745 |

Every frozen object matched byte-for-byte within its seed/self pair across
all measured runs. These ratios include library/allocation work; the binaries
are the existing builds, not freshly rebuilt with matched allocation settings.
The reference seed/self both use jemalloc; v4opt's seed and self differ there.

## Method and limits

The C++ kernels are under `samples/`, with the accessor fixture reused from
`student.tests/pa32/accessor-growth/`. A fixed GCC-built driver/helper object is
linked unchanged to each candidate kernel, without LTO. Calls and unwinding
therefore include some identical host-built work. An independent scalar oracle
checks edge inputs and the full measured input before timing; measured outputs
must match too. The lookup expected sum is computed algebraically. The EH
oracle uses explicit branches instead of exceptions and covers actual throws.

After a warmup, three blocks run GCC, Clang, reference, v4opt, then the reverse
order: six observations per variant. PA34 uses three seed/self/self/seed blocks.
Reported ratios are medians of per-block mean-count ratios. Perf groups
`{instructions:u,cycles:u}` simultaneously; all counters ran at 100%.

The maximum instruction-count range across the six kernel observations was
below 0.00003% of the median. Zero-iteration controls used less than 0.73% of
the instructions of any full sample, including lookup-table setup. PA34 counts
varied more: about 0.018% for reference seed and 0.015% for reference self.
Inputs are fixed, and the suite is small; this does not establish reliability
across hosts or a representative workload distribution.

Instruction counts are not runtime. For example, the reference's accessor
instruction ratio is 1.784 with either pointer arrangement, but its measured
cycle ratios are 2.472 for distinct pointers and 1.439 for aliases. Cycle ratios
are diagnostics, not a statistically qualified runtime gate.

## Selected gate and its scope

The O0 sample is close to GCC while the optimized reference kernels execute
78-127% more instructions. O0 parity would not certify optimized code quality.
A 10% optimized instruction allowance would reject Clang on the accessor case;
25% admits GCC and Clang on these samples but rejects both CPPGM implementations.
Even 50% rejects the reference on all three optimized workload families.

The optimized instruction gate starts at PA33 and remains required at
PA34; the whole-self workload at PA34 remains separate and diagnostic. PA27 can
establish the harness and an informational
O0 baseline. PA32 can investigate emerging gaps; GCC/Clang optimization levels
are not interchangeable with a LowIR-only stage, so no PA32 cross-compiler
acceptance claim is made. The selected 25% allowance applies separately to every
case, with no aggregate score. Broader inputs and independent workload families
should be qualified with GCC and Clang before extending this small suite; it does
not establish whole-program runtime parity. Alias variants are related inputs,
not two independent families.

The initial exploratory run attempted a LowIR-only route, but the reference
rejected `-std=c++11` in emit mode before either PA32 sample ran. Those attempts
are preserved in `obj/backend-quality/pmu-samples/` and excluded from this table.
The complete-pipeline kernel run was repeated with the corrected scope and has
no failures. Fresh PA34 results are extracted in `obj/backend-quality/pa34-samples.json`;
their raw measurements remain in the initial run. No failed measurement was
converted into a pass or used to set a threshold.

## Reproduce

From the repository root:

```sh
python3 student.tests/backend-quality/sample_perf.py --cpu 24 \
  --out obj/backend-quality/new-pmu-samples
```

Use `--skip-frozen` for the PA27/PA33 kernels only. `--reference` and `--ours`
select compiler paths; defaults point to the local cppgm-extended and v4opt
builds. The full run also expects their existing PA34 self binaries and the
frozen workload in `~/cppgm-extended`. Results and generated objects remain
under ignored `obj/`. Ralph now requires the PA33/PA34 kernel gate at final audit;
the compiler implementation was not changed.
