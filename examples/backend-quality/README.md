# Supplemental backend quality controls

This reference bundle contains the controls shared by the native
[v4sol61](../v4sol61/README.md) and [v4svelte](../v4svelte/README.md) examples.
It includes the PA33/PA34 instruction checker, its driver and kernels, the
PA27 emission-growth and PA32 accessor-growth fixtures, and their qualification
and exploratory measurement tools. The original assignment's `pa33/` tests
remain unchanged.

The Python and C++ files are exact copies from preparation commit
`433cb2cbde465843d79cdc1490597a83fda214ab` in `cppgm-run-v4sol61`; they also
match the controls in `cppgm-run-v4svelte` preparation commit
`642a35fd290480d8ee10237f9f9372f8d7036f82`. The accompanying documentation
describes the native examples and retains the historical qualification results.

Both example configs require `check_instructions.py` at the PA33 and PA34
final audits. Each of four workloads must execute at most 1.25 times GCC's
user-mode instructions at matching O2/O3 settings. The checker verifies
behavior before accepting measurements, preserves raw counters and provenance,
and blocks acceptance for failing or inconclusive results. The earlier
growth controls and exploratory sampler are separate tools.

The `student.tests/` layout preserves the runners' relative paths. From this
bundle directory, the earlier controls can be qualified with the host compilers:

```sh
cd examples/backend-quality
python3 student.tests/backend-quality/check.py --stage pa32 \
  --report /tmp/backend-quality-hosts.json
python3 student.tests/backend-quality/qualify.py \
  --report /tmp/backend-quality-negative-controls.json
```

To check a candidate's PA33 instruction budget, use its absolute path:

```sh
python3 student.tests/backend-quality/check_instructions.py --stage pa33 \
  --compiler /absolute/path/to/cppgm++ --cpu 24 \
  --out /tmp/backend-quality-instruction-gate
```

Choose an allowed CPU for the measurement host. The instruction checker needs
Linux x86-64, GCC, `perf`, and access to user-mode hardware counters. The
exploratory sampler additionally expects the compiler/self-build paths described
in its [measurement notes](student.tests/backend-quality/perf-samples.md).
Historical reports and compiler binaries are not included in this bundle.

To install the controls in an assignment checkout, copy this bundle's
`student.tests/` contents into that checkout's `student.tests/` directory.
See the [control contracts and measurement protocol](student.tests/backend-quality/README.md)
for the full policy, commands, limits and historical qualification results.
