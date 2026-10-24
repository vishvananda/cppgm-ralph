#!/usr/bin/env python3
"""Compiler-independent Rust quality gates."""
import sys
from clone_common import CONTROL, ROOT, run


def checks():
    commands = [
        ["cargo", "fmt", "--manifest-path", "dev/Cargo.toml", "--all", "--", "--check"],
        ["cargo", "clippy", "--manifest-path", "dev/Cargo.toml", "--workspace",
         "--all-targets", "--all-features", "--locked", "--", "-D", "warnings"],
        ["cargo", "test", "--manifest-path", "dev/Cargo.toml", "--workspace", "--locked"],
        ["cargo", "test", "--manifest-path", "dev/Cargo.toml", "--workspace", "--release", "--locked"],
        [str(CONTROL / "venv/bin/python"), str(CONTROL / "rust_audit.py"), "--root", str(ROOT)],
    ]
    for command in commands:
        code, out, err = run(command, timeout=1800)
        sys.stdout.buffer.write(out + err)
        if code:
            return code
    return 0


def main():
    from clone_evidence import cached_gate
    return cached_gate("quality", checks, lambda: [], fresh="--fresh" in sys.argv)


if __name__ == "__main__":
    sys.exit(main())
