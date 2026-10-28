#!/usr/bin/env python3
"""Content-bound successful gate reuse and compact raw-evidence indexes."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import shlex
import subprocess
import sys
import time

import clone_common as common

VERSION = 2
HOST_TOOLS = ('g++', 'gcc', 'cc', 'c++', 'ld', 'as', 'ar', 'ranlib', 'nm',
              'objcopy', 'objdump', 'readelf', 'strip', 'addr2line', 'c++filt',
              'make', 'git', 'perl', 'python3', 'cargo', 'rustc', 'rustfmt',
              'clippy-driver', 'cargo-clippy', 'cargo-fmt', 'rustup', 'timeout',
              'gdb', 'valgrind', 'uname', 'getconf', 'nproc', 'cmp', 'diff',
              'find', 'sort', 'sed', 'awk', 'grep', 'head', 'tail', 'wc', 'tr',
              'cut', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'ln', 'touch', 'date',
              'sha256sum', 'xargs', 'sh', 'bash', 'pkg-config', 'install', 'which')
ENV_KEYS = ('PATH', 'RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTUP_TOOLCHAIN',
            'CPPGM_BUILD_HOST_CXX', 'CPPGM_STDLIB_FLAGS',
            'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_ENCODED_RUSTFLAGS',
            'RUST_TEST_THREADS', 'PYTHONHASHSEED',
            'CXX', 'CC', 'CXXFLAGS', 'CFLAGS', 'CPPFLAGS', 'CC_FLAGS', 'CXX_FLAGS',
            'LDFLAGS', 'AR', 'AS', 'LD', 'OPT_LEVEL', 'GCC_COLORS', 'NO_COLOR',
            'LD_LIBRARY_PATH', 'LD_PRELOAD', 'CPATH', 'CPLUS_INCLUDE_PATH',
            'C_INCLUDE_PATH', 'LIBRARY_PATH', 'COMPILER_PATH', 'GCC_EXEC_PREFIX')


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def tree_identity(paths):
    """Hash source bytes and symlink identities, including newly added inputs."""
    digest = hashlib.sha256()
    for root in sorted(set(map(Path, paths))):
        entries = [root]
        if root.is_dir():
            entries += sorted(root.rglob('*'))
        for path in entries:
            if any(part in ('__pycache__', '.git', 'target', 'obj') for part in path.relative_to(root.parent).parts):
                continue
            if path.is_symlink():
                value = ['link', os.readlink(path), common.file_digest(path) if path.is_file() else None]
            elif path.is_file():
                value = ['file', path.stat().st_mode & 0o777, common.file_digest(path)]
            elif path.is_dir():
                continue
            else:
                value = ['missing']
            digest.update(encoded([str(path), value]))
    return digest.hexdigest()


def metadata_identity(roots):
    digest = hashlib.sha256()
    for root in roots:
        if not Path(root).exists():
            digest.update(encoded([str(root), 'missing']))
        for directory, dirs, files in os.walk(root):
            dirs.sort()
            for name in sorted([*dirs, *files]):
                path = Path(directory) / name
                stat = path.lstat()
                digest.update(encoded([str(path), stat.st_mode, stat.st_size,
                                       stat.st_mtime_ns, stat.st_ctime_ns,
                                       os.readlink(path) if path.is_symlink() else None]))
    return digest.hexdigest()


def executable_identity(environment):
    """Bind tools actually used by validation, including PATH resolution/shadowing."""
    executables = {}
    names = set(HOST_TOOLS)
    for key in ('CC', 'CXX', 'AR', 'AS', 'LD', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CPPGM_BUILD_HOST_CXX'):
        words = shlex.split(environment.get(key, ''))
        if words:
            names.add(words[0])
    for name in sorted(names):
        path = shutil.which(name, path=environment.get('PATH'))
        executables[name] = None if path is None else [path, str(Path(path).resolve()), common.file_digest(path)]
    return executables


def host_identity():
    """Bind build tools and system inputs without unrelated PATH-directory churn."""
    environment = common.clean_env()
    executables = executable_identity(environment)
    versions = {}
    for tool in ('rustc', 'cargo'):
        result = subprocess.run([tool, '-vV'], env=environment, capture_output=True, timeout=30, check=True)
        versions[tool] = result.stdout.decode()
    sysroot = Path(subprocess.check_output(['rustc', '--print', 'sysroot'], env=environment, text=True).strip())
    cargo = Path(common.clean_env()['CARGO_HOME'])
    return {'system': list(os.uname()), 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'headers_libraries': metadata_identity(('/usr/include', '/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu')),
            'rust_dependencies': metadata_identity((sysroot / 'bin', sysroot / 'lib', cargo / 'registry/src', cargo / 'git/checkouts',
                                                    common.CONTROL / 'venv/bin', common.CONTROL / 'venv/lib')),
            'executables': executables, 'versions': versions}


def inputs(context):
    root, control = common.ROOT, common.CONTROL
    # Candidate outputs and journals are never inputs. Include untracked Rust
    # sources/config; test inputs are enumerated from Git plus discovery.
    result = subprocess.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                            cwd=root, capture_output=True, check=True)
    names = [os.fsdecode(name) for name in result.stdout.split(b'\0') if name]
    names = [name for name in names if not name.startswith(('docs/', 'reference-binaries/'))
             and not name.endswith(('.md', '.my', '.diff', '.log'))
             and '/.my' not in name and '.my.' not in name
             and name not in ('.test_counts', '.test_failed')
             and not Path(name).name.startswith('.')]
    paths = [root / name for name in names if not name.startswith('dev/')]
    # Discovery also runs ignored, newly added .t cases. Include their input
    # sidecars even when Git's untracked inventory excludes them.
    for tests in root.glob('pa*/tests'):
        paths += [path for path in tests.rglob('*') if '.my' not in path.name
                  and (path.name.endswith(('.t', '.flags', '.expect'))
                       or '.t.' in path.name or '.ref' in path.name)]
    paths += [root / 'dev',
              root / '.cargo', root / 'dev/.cargo', root / 'rust-toolchain.toml']
    paths += [root / name for name in ('rustfmt.toml', '.rustfmt.toml', 'clippy.toml', '.clippy.toml')]
    paths += [path for path in control.glob('*.py')]
    paths += [control / 'bin', control / 'settings.json', control / 'manifest.json']
    paths += [root.parent / 'cache/cargo/config.toml', root.parent / 'cache/cargo/config',
              Path.home() / '.cargo/config.toml', Path.home() / '.cargo/config']
    return {'version': VERSION, 'context': context, 'checkout': str(root), 'control': str(control),
            'files': tree_identity(paths),
            'binaries': {tool: common.file_digest(common.candidate_path(tool)) for tool in common.TOOLS},
            'environment': {key: common.clean_env().get(key) for key in ENV_KEYS},
            'limits': {str(key): list(resource.getrlimit(key)) for key in
                       (resource.RLIMIT_STACK, resource.RLIMIT_AS, resource.RLIMIT_DATA, resource.RLIMIT_NOFILE)},
            'host': host_identity()}


def evidence_files(limit):
    paths = []
    for number in range(1, limit + 1):
        stage = f'pa{number}'
        report = common.ARTIFACTS / 'results' / f'{stage}.json'
        data = json.loads(report.read_text())
        if not data['results'] or not all(row['passed'] for row in data['results']):
            raise ValueError(f'{stage}: incomplete successful evidence')
        paths.append(report)
        for row in data['results']:
            paths += [Path(row['trace']), Path(row['log'])]
        directory = common.ARTIFACTS / 'course' / stage / 'test'
        result = json.loads((directory / 'course-result.json').read_text())
        if not result['passed']:
            raise ValueError(f'{stage}: failed course evidence')
        paths += [directory / name for name in ('course-result.json', 'course.log', 'trace.jsonl')]
        if (directory / 'counts.txt').exists():
            paths.append(directory / 'counts.txt')
    return sorted(set(paths))


def file_inventory(paths):
    return {str(path): common.file_digest(path) for path in paths}


def valid_receipt(receipt, identity):
    try:
        return (receipt['version'] == VERSION and receipt['identity'] == identity
                and receipt['exit'] == 0 and bool(receipt['evidence'])
                and all(common.file_digest(path) == digest for path, digest in receipt['evidence'].items()))
    except (KeyError, TypeError, OSError, ValueError):
        return False


class Tee:
    def __init__(self, stream, log):
        self.stream, self.log = stream, log
        self.buffer = ByteTee(self)

    def write(self, text):
        self.stream.write(text)
        self.log.write(text)
        return len(text)

    def flush(self):
        self.stream.flush()
        self.log.flush()


class ByteTee:
    def __init__(self, owner):
        self.owner = owner

    def write(self, data):
        return self.owner.write(data.decode('utf-8', errors='replace'))

    def flush(self):
        self.owner.flush()


def cached_gate(context, action, evidence, *, fresh=False):
    """Only success is reusable; invalid inputs/evidence always execute the gate."""
    directory = common.ARTIFACTS / 'validation' / context
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = inputs(context)
        identity = common.digest(encoded(before))
        receipt_path = directory / 'receipt.json'
        try:
            saved = json.loads(receipt_path.read_text())
        except (OSError, ValueError):
            saved = {}
        if not fresh and valid_receipt(saved, identity):
            print(f'Validation reuse: {context}; exact unchanged inputs and raw evidence; {receipt_path}', flush=True)
            print(Path(saved['log']).read_text(), end='')
            return 0
        # A forced/invalidated attempt supersedes old success even if it raises.
        receipt_path.unlink(missing_ok=True)
        log_path = directory / f'{time.time_ns()}.log'
        with log_path.open('w') as log:
            with contextlib.redirect_stdout(Tee(sys.stdout, log)), contextlib.redirect_stderr(Tee(sys.stderr, log)):
                code = action()
        if code:
            return code
        inventory = file_inventory([log_path, *evidence()])
        if inputs(context) != before:
            raise RuntimeError('validation inputs changed while checking; result cannot be reused')
        common.write_json(receipt_path, {'version': VERSION, 'context': context, 'identity': identity,
                                        'inputs': before, 'exit': 0, 'log': str(log_path),
                                        'evidence': inventory})
        print(f'Validation receipt: {receipt_path}', flush=True)
        return 0


def snapshot(stage, destination):
    """Index current results without copying every case or claiming acceptance."""
    report_path = common.ARTIFACTS / 'results' / f'{stage}.json'
    report = json.loads(report_path.read_text())
    binaries = {tool: common.file_digest(common.candidate_path(tool)) for tool in common.TOOLS}
    if report['binaries'] != binaries:
        raise ValueError('stage report is stale for current compiler binaries')
    if report['manifest_sha256'] != common.file_digest(common.CONTROL / 'manifest.json'):
        raise ValueError('stage report is stale for current protected manifest')
    from clone_check import stage_cases
    if [row['case'] for row in report['results']] != stage_cases(stage):
        raise ValueError('stage report does not cover the current case inventory')
    prior, quality = {}, {}
    for context, target in ((f'prior-{stage}', prior), ('quality', quality)):
        path = common.ARTIFACTS / 'validation' / context / 'receipt.json'
        saved = json.loads(path.read_text())
        if not valid_receipt(saved, common.digest(encoded(inputs(context)))):
            raise ValueError(f'{context}: missing or stale successful receipt; run the required gate')
        target.update(path=str(path), sha256=common.file_digest(path), reused_success=True)
    rows = report['results']
    index = {'kind': 'validation-evidence-index', 'acceptance_claim': False, 'stage': stage,
             'binaries': binaries, 'manifest_sha256': report['manifest_sha256'],
             'stage_report': {'path': str(report_path), 'sha256': common.file_digest(report_path)},
             'passed': sum(row['passed'] for row in rows), 'total': len(rows),
             'remaining': [row['case'] for row in rows if not row['passed']],
             'prior': prior, 'quality': quality}
    common.write_json(destination, index)
    print(f"Evidence index: {destination}; {index['passed']}/{index['total']}; raw receipts retained in place")


def receipt_status(context, current):
    """Describe evidence without running a gate or promoting stale success."""
    path = common.ARTIFACTS / 'validation' / context / 'receipt.json'
    result = {'path': str(path), 'reused_success': False}
    if path.exists():
        result['sha256'] = common.file_digest(path)
        try:
            saved = json.loads(path.read_text())
            identity = common.digest(encoded({**current, 'context': context}))
            result['reused_success'] = valid_receipt(saved, identity)
        except (OSError, ValueError, TypeError):
            pass
    return result


def checkpoint(stage, destination, focused=()):
    """Index an open audit; final acceptance still requires the strict snapshot."""
    current = inputs('checkpoint')
    report_path = common.ARTIFACTS / 'results' / f'{stage}.json'
    report = {'path': str(report_path), 'current': False}
    if report_path.exists():
        report['sha256'] = common.file_digest(report_path)
        saved = json.loads(report_path.read_text())
        from clone_check import stage_cases
        report['current'] = (
            saved.get('binaries') == current['binaries']
            and saved.get('manifest_sha256') == common.file_digest(common.CONTROL / 'manifest.json')
            and [row['case'] for row in saved['results']] == stage_cases(stage))
        report.update(passed=sum(row['passed'] for row in saved['results']), total=len(saved['results']))
    index = {
        'kind': 'audit-review-checkpoint', 'acceptance_claim': False,
        'final_acceptance_required': True, 'stage': stage,
        'input_identity': common.digest(encoded(current)), 'binaries': current['binaries'],
        'manifest_sha256': common.file_digest(common.CONTROL / 'manifest.json'),
        'stage_report': report, 'prior': receipt_status(f'prior-{stage}', current),
        'quality': receipt_status('quality', current),
        'focused_evidence': file_inventory(Path(path).resolve() for path in focused),
    }
    common.write_json(destination, index)
    print(f'Audit review checkpoint: {destination}; final acceptance checks remain required')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['snapshot', 'checkpoint'])
    parser.add_argument('stage')
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--evidence', action='append', default=[], type=Path)
    args = parser.parse_args()
    if not __import__('re').fullmatch(r'pa(?:[1-9]|[12][0-9]|3[0-3])', args.stage):
        parser.error('stage must be pa1 through pa33')
    if args.mode == 'checkpoint':
        checkpoint(args.stage, args.out, args.evidence)
    else:
        if args.evidence:
            parser.error('--evidence is only for an audit checkpoint')
        snapshot(args.stage, args.out)


if __name__ == '__main__':
    main()
