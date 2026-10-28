#!/usr/bin/env python3
"""Quality checks that preserve the literal source structure."""
import argparse
import sys
from clone_common import CONTROL, ROOT, run


def commands():
    return [
        ['cargo', 'fmt', '--manifest-path', 'dev/Cargo.toml', '--all', '--', '--check'],
        ['cargo', 'clippy', '--manifest-path', 'dev/Cargo.toml', '--workspace', '--all-targets', '--all-features', '--locked'],
        ['cargo', 'test', '--manifest-path', 'dev/Cargo.toml', '--workspace', '--locked'],
        ['cargo', 'test', '--manifest-path', 'dev/Cargo.toml', '--workspace', '--release', '--locked'],
        [str(CONTROL / 'venv/bin/python'), str(CONTROL / 'port_audit.py')],
    ]


def run_checks(selected):
    for command in selected:
        code, out, err = run(command, timeout=1800)
        sys.stdout.buffer.write(out + err)
        if code:
            return code
    return 0


def checks():
    return run_checks(commands())


def review_checks():
    return run_checks(command for command in commands() if command[:2] != ['cargo', 'test'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--review', action='store_true')
    modes.add_argument('--fresh', action='store_true')
    args = parser.parse_args()
    if args.review:
        return review_checks()
    from clone_evidence import cached_gate
    return cached_gate('quality', checks, lambda: [], fresh=args.fresh)


if __name__ == '__main__':
    sys.exit(main())
