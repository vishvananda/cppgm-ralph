#!/usr/bin/env python3
"""Restrict the student's home view before Ralph's ordinary storage overlays."""
import os
from pathlib import Path
import sys

HOME = Path('/home/vishvananda')
BASE = HOME / 'work'
CONTROL = BASE / 'v5scratch-control'
PROVIDER = BASE / 'v5scratch-provider'
ROOT = BASE / 'private/v5scratch/checkout'
CODEX_RUNTIME = HOME / '.local/lib/node_modules/@openai/codex'


def sandbox_args(arguments):
    try:
        index = arguments.index('--ro-bind')
    except ValueError as error:
        raise ValueError('student isolation requires a read-only host root') from error
    if arguments[index + 1:index + 3] != ['/', '/']:
        raise ValueError('student isolation requires a read-only host root')
    hidden = ['/home']
    additions = ['--tmpfs', '/home']
    for mount in ['/mnt', '/media', '/root']:
        if Path(mount).is_dir():
            hidden.append(mount)
            additions.extend(['--tmpfs', mount])
    for directory in [HOME / '.rustup', HOME / '.cargo/bin', CODEX_RUNTIME, CONTROL, PROVIDER]:
        if not directory.is_dir():
            raise ValueError(f'missing required student runtime directory: {directory}')
        additions.extend(['--ro-bind', str(directory), str(directory)])
    # The private volume, scratch, current Ralph state and provider write mounts
    # are supplied afterwards by Ralph. No other home directory is restored.
    additions.extend(['--symlink', str(ROOT), str(BASE / 'v5scratch')])
    result = arguments[:index + 3] + additions + arguments[index + 3:]
    boundary = result.index('--chdir')
    # Freeze the empty parent trees after all child mounts have been restored.
    # Bind mounts for the private volume/provider state keep their own flags.
    readonly = [argument for mount in hidden for argument in ['--remount-ro', mount]]
    return result[:boundary] + readonly + result[boundary:]


if __name__ == '__main__':
    os.execv('/usr/bin/bwrap', ['bwrap', *sandbox_args(sys.argv[1:])])
