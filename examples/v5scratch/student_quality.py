#!/usr/bin/env python3
"""Rust quality checks independent of the compiler's course outputs."""
import os
from pathlib import Path
import subprocess


def main():
    root = Path.cwd().resolve()
    env = os.environ | {'CARGO_HOME': str(root.parent / 'cache/cargo'),
                        'CARGO_TARGET_DIR': str(root / 'obj/rust'),
                        'CLIPPY_CONF_DIR': str(root / 'dev')}
    common = ["--manifest-path", "dev/Cargo.toml", "--workspace", "--locked"]
    commands = [
        ["cargo", "fmt", "--manifest-path", "dev/Cargo.toml", "--all", "--", "--check"],
        ["cargo", "clippy", *common, "--all-targets", "--all-features", "--", "-D", "warnings"],
        ["cargo", "test", *common],
    ]
    for command in commands:
        result = subprocess.run(command, check=False, env=env)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
