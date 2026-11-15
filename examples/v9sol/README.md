# V9 Sol release-gated scaffold

Prepared for cppgm **v0.9.1**, source
`c9b05c4c0f7bb1294c717551c61145940b21125e`, and exported assignments
`57072c63636274eed3088da8ae3ac1164478117a`. Its reference manifest names
that exact source. The immutable release tag must match; the release must
be a descendant of the `assignments-v9` course base. An explicit exported
commit is accepted when no matching assignments version tag exists; its
manifest must still match the release. No moving branch substitutes for a pin.

The student run uses native Codex `gpt-6.1-sol` / `high`, fresh phase goals,
the existing compact-storage and register-placement guidance, a 500-turn
limit, and default authentication. It implements required PA1–37: assembly
at PA29, LowIR/backend optimization at PA33/34, bootstrap at PA35, compiler
performance at PA36 and wasm at PA37. Optional PA38 C is not selected.
The separate Rust translation must include PA38 as part of its full parity.

Validate the configuration and all 18 concise prompt/goal templates:

```sh
node examples/v9sol/verify-setup.mjs
```

After the release and assignments export have been tagged, fetch both in
separate source/export checkouts, then prepare a reviewable migration:

```sh
python3 scripts/prepare-v9sol.py --source ~/cppgm-extended \
  --assignments ~/cppgm-assignments-release \
  --version v0.9.1 \
  --source-revision c9b05c4c0f7bb1294c717551c61145940b21125e \
  --assignments-revision 57072c63636274eed3088da8ae3ac1164478117a \
  --output /mnt/vizier/v9sol-prepared
```

The command refuses changed or started V8 work and missing/mismatched tags.
It preserves the V8 preparation history, merges the exact assignments export,
and verifies that only `spec.md` differs from the released tree. Existing
V8 checkout/configuration/state remain untouched during preparation.

Use `--apply` with a fresh output directory beneath the V8 private filesystem
to rename its GitHub repository, push the prepared history, install the V9
checkout/sidecars and archive the old checkout/sidecars. The mounted V8 LVM
storage path is retained in sandbox configuration; public run and future state
paths use V9. Both preparation and installation leave the worker unstarted.
No credentials, historical plans, implementation work or Ralph state are copied.
