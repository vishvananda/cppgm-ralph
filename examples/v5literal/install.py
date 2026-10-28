#!/usr/bin/env python3
"""Provision a fresh literal port, verify it, commit it and create its private remote."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
NAME = 'v5literal'
BASELINE = '22cd2cd17f660b765c8118e9675fab676daec714'


def run(*args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def provision(base):
    root = base / 'private' / NAME
    image = base / 'private-images' / (NAME + '.ext4')
    if root.exists() or image.exists():
        raise RuntimeError('private root/image exists; refusing to overwrite or format it')
    device = Path('/dev/vg0/cppgm_' + NAME)
    if device.exists():
        raise RuntimeError('existing logical volume must not be reformatted')
    free = subprocess.run(['sudo', '-n', 'vgs', '--noheadings', '--units', 'b', '--nosuffix', '-o', 'vg_free', 'vg0'], capture_output=True, text=True)
    if free.returncode == 0 and float(free.stdout.strip()) >= 100 * 1024 ** 3:
        run('sudo', '-n', 'lvcreate', '-L', '100G', '-n', 'cppgm_' + NAME, 'vg0')
        run('sudo', '-n', 'mkfs.ext4', '-q', '-m', '0', device)
        root.mkdir(mode=0o700)
        run('sudo', '-n', 'mount', '-o', 'nosuid,nodev', device, root)
        uuid = subprocess.check_output(['sudo', '-n', 'blkid', '-s', 'UUID', '-o', 'value', str(device)], text=True).strip()
        line = f'UUID={uuid} {root} ext4 nosuid,nodev,nofail,x-systemd.device-timeout=30 0 2\n'
    else:
        image.parent.mkdir(mode=0o700, exist_ok=True)
        descriptor = os.open(image, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.ftruncate(descriptor, 100 * 1024 ** 3)
        finally:
            os.close(descriptor)
        run('sudo', '-n', 'mkfs.ext4', '-q', '-m', '0', image)
        root.mkdir(mode=0o700)
        run('sudo', '-n', 'mount', '-o', 'loop,nosuid,nodev', image, root)
        line = f'{image} {root} ext4 loop,nosuid,nodev,nofail,x-systemd.device-timeout=30 0 0\n'
    run('sudo', '-n', 'chown', f'{os.getuid()}:{os.getgid()}', root)
    root.chmod(0o700)
    # A sparse loop filesystem retains the same 100 GiB hard boundary without
    # consuming scarce LVM extents or allocating its entire capacity up front.
    existing = subprocess.check_output(['sudo', '-n', 'cat', '/etc/fstab'], text=True)
    if str(root) in existing or str(image) in existing:
        raise RuntimeError('fstab already mentions the new storage path')
    run('sudo', '-n', 'tee', '-a', '/etc/fstab', input=line, text=True, stdout=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=Path('/home/vishvananda/work'))
    parser.add_argument('--reference-seed', type=Path, default=Path('/home/vishvananda/work/references/v5rust-cpp'))
    parser.add_argument('--no-remote', action='store_true')
    args = parser.parse_args(); base = args.base.resolve()
    root = base / 'private' / NAME / 'checkout'; control = base / (NAME + '-control')
    reference = base / 'references' / (NAME + '-cpp')
    remote = 'vishvananda/cppgm-run-' + NAME
    for path in (root, reference, base / NAME, base / (NAME + '.config.json'), base / '.ralph' / (NAME + '-gpt-6.1-sol-high')):
        if path.exists() or path.is_symlink():
            raise RuntimeError(f'refusing to overwrite {path}')
    if not args.no_remote and subprocess.run(['gh', 'repo', 'view', remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise RuntimeError('remote already exists')
    seed = args.reference_seed.resolve()
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=seed, text=True).strip()
    if actual != BASELINE or subprocess.check_output(['git', 'status', '--porcelain'], cwd=seed, text=True).strip():
        raise RuntimeError('reference seed must be clean and pinned')
    provision(base)
    run('git', 'clone', '--no-hardlinks', seed, reference)
    run('git', 'remote', 'set-url', 'origin', 'https://github.com/vishvananda/cppgm-extended.git', cwd=reference)
    run('git', 'checkout', '--detach', BASELINE, cwd=reference)
    for tool in ('pptoken', 'posttoken', 'ppexpr', 'preproc', 'cppgm++', 'abimangle', 'lowir', 'lowiropt', 'lowir2native'):
        shutil.copy2(seed / 'dev' / tool, reference / 'dev' / tool)
    python = control / 'venv/bin/python'
    if not python.exists():
        run(sys.executable, '-m', 'venv', control / 'venv')
    run(python, '-m', 'pip', 'install', '-r', HERE / 'requirements.txt')
    run(python, HERE / 'scaffold.py', '--base', base)
    environment = dict(os.environ, CARGO_HOME=str(root.parent / 'cache/cargo'), CARGO_TARGET_DIR=str(root / 'obj/rust'))
    run('cargo', 'fmt', '--manifest-path', 'dev/Cargo.toml', '--all', cwd=root, env=environment)
    run('make', 'build', cwd=root, env=environment)
    # Hashes for frozen support files are set after generated Rust formatting.
    run('git', 'add', '.', cwd=root)
    run('git', 'commit', '-m', 'Scaffold source-faithful mechanical Rust port with reviewed unsafe', cwd=root)
    run(python, HERE / 'verify.py', '--base', base)
    if not args.no_remote:
        run('gh', 'repo', 'create', remote, '--private', '--source', root, '--remote', 'origin')
        run('git', 'remote', 'set-url', 'origin', 'git@github.com:' + remote + '.git', cwd=root)
        run('git', 'push', '-u', 'origin', 'main', cwd=root)
    print('Scaffold complete, committed and unstarted:', root)


if __name__ == '__main__':
    main()
