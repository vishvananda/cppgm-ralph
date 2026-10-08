#!/usr/bin/env python3
"""Supplemental PA33/PA34 gate: each kernel <= 1.25x GCC retired instructions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import tempfile
import time

from check import object_sizes

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LIMIT = 1.25
BLOCKS = 3
MAX_SPREAD = 0.005
MAX_STARTUP = 0.01
EVENTS = ('instructions:u', 'cycles:u')
CASES = (
    ('accessor-distinct', 1, ROOT/'student.tests/pa32/accessor-growth/kernel.cpp', 2, 64, 1 << 24, 0),
    ('accessor-alias', 1, ROOT/'student.tests/pa32/accessor-growth/kernel.cpp', 2, 64, 1 << 24, 1),
    ('lookup', 2, HERE/'samples/lookup.cpp', 3, 0, 1 << 25, 0),
    ('exceptions', 3, HERE/'samples/exception.cpp', 3, 0, 1 << 23, 0),
)


class MeasurementError(RuntimeError):
    """Missing or unstable evidence; never a passing measurement."""


class BehaviorError(RuntimeError):
    """The compiler or its generated program failed a correctness check."""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parse_perf(path):
    events = {}
    try:
        for line in path.read_text().splitlines():
            fields = line.split(',')
            if len(fields) >= 5 and fields[2] in EVENTS:
                count, running = int(fields[0]), float(fields[4])
                if count <= 0 or running != 100.0 or fields[2] in events:
                    raise ValueError('nonpositive, multiplexed or duplicate counter')
                events[fields[2]] = dict(count=count, running_percent=running)
        if set(events) != set(EVENTS):
            raise ValueError('missing counter')
    except (OSError, ValueError) as error:
        raise MeasurementError(f'{path}: {error}') from error
    return events


def verdict(ratios, spreads, startup):
    if max(spreads) > MAX_SPREAD or max(startup) > MAX_STARTUP:
        return 'INCONCLUSIVE'
    if max(ratios) <= LIMIT:
        return 'PASS'
    if min(ratios) > LIMIT:
        return 'FAIL'
    return 'INCONCLUSIVE'  # Blocks straddle the limit; don't choose favorable runs.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True, choices=[f'pa{i}' for i in range(1, 35)])
    parser.add_argument('--compiler', default='./dev/cppgm++')
    parser.add_argument('--gcc', default='g++')
    parser.add_argument('--cpu', type=int, default=None)
    parser.add_argument('--out', type=Path, default=ROOT/'obj/backend-quality/instructions')
    args = parser.parse_args()
    if args.stage not in ('pa33', 'pa34'):
        print('NOT_APPLICABLE: optimized instruction budget starts at PA33')
        return 0

    args.out.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='run-', dir=args.out.resolve()))
    report = dict(stage=args.stage, status='RUNNING', groups=[], commands=[],
                  policy=dict(limit=LIMIT, blocks=BLOCKS, max_spread=MAX_SPREAD,
                              max_startup=MAX_STARTUP, required_running_percent=100,
                              order=['gcc', 'candidate', 'candidate', 'gcc']),
                  sources={}, compilers={})

    def save():
        (out/'results.json').write_text(json.dumps(report, indent=2)+'\n')

    def run(command, measurement=False):
        command = [str(x) for x in command]
        report['commands'].append(command)
        try:
            process = subprocess.run(command, capture_output=True, text=True,
                                     timeout=120, env={**os.environ, 'LC_ALL': 'C'})
        except (OSError, subprocess.TimeoutExpired) as error:
            error_type = MeasurementError if measurement else BehaviorError
            raise error_type(f'{command}: {error}') from error
        if process.returncode:
            error_type = MeasurementError if measurement else BehaviorError
            raise error_type(f'{command}: exit {process.returncode}\n'
                             f'{process.stdout}{process.stderr}')
        return process.stdout

    def measure(command, path, expected):
        start = time.monotonic()
        output = run(['taskset', '-c', args.cpu, 'perf', 'stat', '-x,',
                      '-e', '{instructions:u,cycles:u}', '-o', path, '--', *command],
                     measurement=True)
        if output != expected:
            raise BehaviorError(f'measured output mismatch: {command}')
        return dict(events=parse_perf(path), stdout=output, perf_csv=str(path),
                    elapsed_including_perf=time.monotonic()-start)

    try:
        allowed = os.sched_getaffinity(0)
        args.cpu = min(allowed) if args.cpu is None else args.cpu
        if args.cpu not in allowed:
            raise MeasurementError(f'CPU {args.cpu} is outside allowed affinity {sorted(allowed)}')
        report['cpu'] = args.cpu
        report['cpu_info'] = run(['lscpu'])
        report['perf_version'] = run(['perf', '--version']).strip()
        compilers = {}
        for label, value in [('gcc', args.gcc), ('candidate', args.compiler)]:
            resolved = shutil.which(value)
            if resolved is None:
                raise MeasurementError(f'compiler not found: {value}')
            compilers[label] = str(Path(resolved).resolve())
            report['compilers'][label] = dict(path=compilers[label], sha256=sha(compilers[label]))
        report['gcc_version'] = run([compilers['gcc'], '--version']).strip()
        macros = run([compilers['gcc'], '-dM', '-E', '-x', 'c++', '/dev/null'])
        if '#define __GNUC__ ' not in macros or '#define __clang__ ' in macros:
            raise MeasurementError('--gcc must select GCC, not another compiler')
        sources = {Path(__file__), HERE/'check.py', HERE/'samples/driver.cpp',
                   HERE/'samples/lookup.h', *(case[2] for case in CASES)}
        report['sources'] = {str(p): sha(p) for p in sorted(sources)}
        save()

        for name, case, source, level, depth, count, alias in CASES:
            directory = out/name
            directory.mkdir()
            group = dict(name=name, level=level, route='full-pipeline', iterations=count,
                         alias=alias, binaries={}, objects={}, runs=[], empty_runs={},
                         status='RUNNING')
            report['groups'].append(group)
            try:
                driver = directory/'driver.o'
                run([compilers['gcc'], '-std=c++11', '-O2', f'-DQUALITY_CASE={case}',
                     '-c', HERE/'samples/driver.cpp', '-o', driver])
                group['driver_sha256'] = sha(driver)
                for label, compiler in compilers.items():
                    obj, program = directory/(label+'.o'), directory/label
                    run([compiler, '-std=c++11', f'-O{level}', '-g0',
                         f'-DQUALITY_DEPTH={depth}', '-c', source, '-o', obj])
                    run([compilers['gcc'], driver, obj, '-o', program])
                    group['binaries'][label] = dict(path=str(program), sha256=sha(program))
                    group['objects'][label] = dict(sha256=sha(obj), **object_sizes(obj))
                oracle = run([directory/'gcc', 'oracle', count, alias])
                empty_oracle = run([directory/'gcc', 'oracle', 0, alias])
                group['expected'] = oracle
                edges = [0, 1, 3, 4, 15, 16, 17, 18, 257, 1023, 1024, 1025]
                if case == 3:
                    edges += [(1 << 20)+18]
                group['checked_counts'] = edges + [count]
                for label in compilers:
                    for n in edges:
                        expected = run([directory/'gcc', 'oracle', n, alias])
                        if run([directory/label, 'actual', n, alias]) != expected:
                            raise BehaviorError(f'{label} count {n}: wrong result')
                    if run(['taskset', '-c', args.cpu, directory/label,
                            'actual', count, alias]) != oracle:
                        raise BehaviorError(f'{label}: warmup result differs')
                    group['empty_runs'][label] = measure(
                        [directory/label, 'actual', 0, alias],
                        directory/(label+'-empty.csv'), empty_oracle)
                for block in range(BLOCKS):
                    for position, label in enumerate(report['policy']['order']):
                        record = measure([directory/label, 'actual', count, alias],
                                         directory/f'{block}-{position}-{label}.csv', oracle)
                        record.update(label=label, block=block, position=position)
                        group['runs'].append(record)
                    save()
                group['summary'] = {}
                for event in EVENTS:
                    counts = {label: [r['events'][event]['count'] for r in group['runs']
                                      if r['label'] == label] for label in compilers}
                    ratios = []
                    for block in range(BLOCKS):
                        means = {label: statistics.mean(
                            r['events'][event]['count'] for r in group['runs']
                            if r['label'] == label and r['block'] == block)
                                 for label in compilers}
                        ratios.append(means['candidate']/means['gcc'])
                    group['summary'][event] = dict(
                        block_ratios=ratios, median_ratio=statistics.median(ratios),
                        counts={k: dict(median=statistics.median(v), min=min(v), max=max(v),
                                        spread=(max(v)-min(v))/statistics.median(v))
                                for k, v in counts.items()})
                summary = group['summary']['instructions:u']
                startup = {label: group['empty_runs'][label]['events']['instructions:u']['count']
                           / summary['counts'][label]['median'] for label in compilers}
                group['startup_fractions'] = startup
                group['status'] = verdict(summary['block_ratios'],
                                          [v['spread'] for v in summary['counts'].values()],
                                          list(startup.values()))
                print(f"{name}: {summary['median_ratio']:.6f}x GCC "
                      f"(limit {LIMIT:.2f}) {group['status']}", flush=True)
            except MeasurementError as error:
                group.update(status='INCONCLUSIVE', error=str(error))
            except (BehaviorError, OSError, ValueError) as error:
                group.update(status='FAIL', error=str(error))
            if 'error' in group:
                print(f"{name}: {group['status']}: {group['error']}", flush=True)
            save()

        # Detect changes during the run, rather than mixing compiler generations.
        for info in report['compilers'].values():
            if sha(info['path']) != info['sha256']:
                raise MeasurementError('compiler changed during measurement')
        for path, digest in report['sources'].items():
            if sha(path) != digest:
                raise MeasurementError('fixture or policy changed during measurement')
        statuses = {group['status'] for group in report['groups']}
        report['status'] = ('FAIL' if 'FAIL' in statuses else
                            'INCONCLUSIVE' if statuses != {'PASS'} else 'PASS')
    except (MeasurementError, BehaviorError, OSError, ValueError) as error:
        report.update(status='INCONCLUSIVE', error=str(error))
        print(str(error), flush=True)
    save()
    print(f"{report['status']}: {out/'results.json'}", flush=True)
    return {'PASS': 0, 'FAIL': 1, 'INCONCLUSIVE': 2}[report['status']]


if __name__ == '__main__':
    raise SystemExit(main())
