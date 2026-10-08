#!/usr/bin/env python3
"""Exploratory full-pipeline PMU samples: PA27 baseline, PA33 kernels and PA34."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import statistics
import subprocess
import time

from check import object_sizes

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--cpu', default='24')
    parser.add_argument('--blocks', type=int, default=3)
    parser.add_argument('--reference', default=str(Path.home() / 'cppgm-extended/dev/cppgm++'))
    parser.add_argument('--ours', default=str(Path.home() / 'cppgm-run-v4codex/dev/cppgm++'))
    parser.add_argument('--skip-frozen', action='store_true')
    args = parser.parse_args()
    if args.blocks < 3:
        parser.error('at least three blocks required')
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    compilers = dict(gcc=shutil.which('g++'), clang=shutil.which('clang++'),
                     reference=args.reference, ours=args.ours)
    compilers = {k: str(Path(v).resolve()) for k, v in compilers.items()}
    report = dict(cpu=args.cpu, blocks=args.blocks, commands=[], groups=[], failures=[],
                  compilers={k: dict(path=v, sha256=sha(v)) for k, v in compilers.items()},
                  policy_sha256=sha(__file__))
    sources = list((HERE/'samples').glob('*')) + [ROOT/'student.tests/pa32/accessor-growth/kernel.cpp']
    report['sources'] = {str(p): sha(p) for p in sources if p.is_file()}
    report['cpu_info'] = subprocess.check_output(['lscpu'], text=True)
    report['versions'] = {k: subprocess.check_output([compilers[k], '--version'], text=True).splitlines()[0]
                          for k in ['gcc', 'clang']}

    def save():
        (out/'results.json').write_text(json.dumps(report, indent=2)+'\n')

    def run(command):
        command = [str(x) for x in command]
        report['commands'].append(command)
        p = subprocess.run(command, capture_output=True, text=True, timeout=120)
        if p.returncode:
            raise RuntimeError(f'{command}: exit {p.returncode}\n{p.stdout}{p.stderr}')
        return p.stdout

    def measure(command, path, expected=None):
        start = time.monotonic()
        output = run(['taskset', '-c', args.cpu, 'perf', 'stat', '-x,',
                      '-e', '{instructions:u,cycles:u}', '-o', path, '--', *command])
        elapsed = time.monotonic()-start
        if expected is not None and output != expected:
            raise RuntimeError(f'output mismatch: {command}: {output!r} != {expected!r}')
        events = {}
        for line in path.read_text().splitlines():
            fields = line.split(',')
            if len(fields) >= 5 and fields[2] in ['instructions:u', 'cycles:u']:
                count = int(fields[0]); running = float(fields[4])
                if running < 99:
                    raise RuntimeError(f'counter multiplexed: {line}')
                events[fields[2]] = dict(count=count, running_percent=running)
        if len(events) != 2:
            raise RuntimeError(f'missing counters: {path}')
        return dict(events=events, elapsed_including_perf=elapsed, stdout=output, perf_csv=str(path))

    def summarize(group, baseline):
        summary = {}
        for label in group['binaries']:
            item = {}
            for event in ['instructions:u', 'cycles:u']:
                block_ratios = []
                for block in range(args.blocks):
                    a = [r['events'][event]['count'] for r in group['runs']
                         if r['block'] == block and r['label'] == baseline]
                    b = [r['events'][event]['count'] for r in group['runs']
                         if r['block'] == block and r['label'] == label]
                    block_ratios.append(statistics.mean(b)/statistics.mean(a))
                counts = [r['events'][event]['count'] for r in group['runs'] if r['label'] == label]
                item[event] = dict(median_count=statistics.median(counts), min_count=min(counts),
                                   max_count=max(counts), median_ratio=statistics.median(block_ratios),
                                   block_ratios=block_ratios)
            summary[label] = item
        group['summary'] = summary
        print(group['name'], json.dumps({k: round(v['instructions:u']['median_ratio'], 4)
                                        for k, v in summary.items()}), flush=True)

    accessor = ROOT/'student.tests/pa32/accessor-growth/kernel.cpp'
    cases = [
        ('pa27-call-loop-O0', 1, accessor, 0, 0, 1 << 24, 0),
        ('pa33-accessor-distinct', 1, accessor, 2, 64, 1 << 24, 0),
        ('pa33-accessor-alias', 1, accessor, 2, 64, 1 << 24, 1),
        ('pa33-lookup', 2, HERE/'samples/lookup.cpp', 3, 0, 1 << 25, 0),
        ('pa33-exceptions', 3, HERE/'samples/exception.cpp', 3, 0, 1 << 23, 0),
    ]
    for name, case, source, level, depth, count, alias in cases:
        directory = out/name; directory.mkdir(exist_ok=True)
        group = dict(name=name, level=level, route="full-pipeline", iterations=count, alias=alias,
                     binaries={}, runs=[], empty_runs={}, objects={})
        report['groups'].append(group)
        try:
            driver = directory/'driver.o'
            run([compilers['gcc'], '-std=c++11', '-O2', f'-DQUALITY_CASE={case}', '-c',
                 HERE/'samples/driver.cpp', '-o', driver])
            for label, compiler in compilers.items():
                obj = directory/(label+'.o'); program = directory/label
                flags = ['-std=c++11', f'-O{level}', '-g0', f'-DQUALITY_DEPTH={depth}']
                run([compiler, *flags, '-c', source, '-o', obj])
                run([compilers['gcc'], driver, obj, '-o', program])
                group['binaries'][label] = dict(path=str(program), sha256=sha(program))
                group['objects'][label] = object_sizes(obj)
            oracle = run([directory/'gcc', 'oracle', count, alias])
            empty_oracle = run([directory/'gcc', 'oracle', 0, alias])
            group['expected'] = oracle
            for label in compilers:
                # Validate edge counts before measurement, then warm full input.
                for n in [0, 1, 3, 4, 17, 257, (1 << 20)+18] if case == 3 else [0, 1, 3, 4, 17, 257]:
                    wanted = run([directory/'gcc', 'oracle', n, alias])
                    got = run([directory/label, 'actual', n, alias])
                    if got != wanted:
                        raise RuntimeError(f'{name} {label} count {n}: wrong result')
                got = run(['taskset', '-c', args.cpu, directory/label, 'actual', count, alias])
                if got != oracle:
                    raise RuntimeError(f'{name} {label}: warm output differs')
                group['empty_runs'][label] = measure([directory/label, 'actual', 0, alias],
                                                       directory/(label+'-empty.csv'), empty_oracle)
            order = list(compilers)
            for block in range(args.blocks):
                for position, label in enumerate(order+list(reversed(order))):
                    record = measure([directory/label, 'actual', count, alias],
                                     directory/f'{block}-{position}-{label}.csv', oracle)
                    record.update(label=label, block=block, position=position)
                    group['runs'].append(record)
                save()
            summarize(group, 'gcc')
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
            group['error'] = str(error); report['failures'].append(f'{name}: {error}')
            print('ERROR', name, error, flush=True)
        save()

    if not args.skip_frozen:
        frozen = Path.home()/'cppgm-extended/benchmarks/self_compile/stable'
        report['frozen_source_sha256'] = sha(frozen/'semantic_overload.cpp')
        for family, home in [('reference', Path.home()/'cppgm-extended'),
                             ('ours', Path.home()/'cppgm-run-v4codex')]:
            directory=out/('pa34-'+family); directory.mkdir(exist_ok=True)
            executables=dict(seed=Path(compilers[family]), self=(home/'pa34/cppgm++-self').resolve())
            group=dict(name='pa34-'+family, binaries={k:dict(path=str(v),sha256=sha(v)) for k,v in executables.items()}, runs=[])
            report['groups'].append(group)
            try:
                outputs=[]
                def command(label):
                    return [executables[label], '-O0', '-std=gnu++11', '-I', frozen/'include',
                            '-c', frozen/'semantic_overload.cpp', '-o', directory/(label+'.o')]
                for label in executables:
                    run(['taskset', '-c', args.cpu, *command(label)])
                for block in range(args.blocks):
                    for position,label in enumerate(['seed','self','self','seed']):
                        record=measure(command(label), directory/f'{block}-{position}-{label}.csv')
                        digest=sha(directory/(label+'.o')); outputs.append(digest)
                        record.update(label=label,block=block,position=position,output_sha256=digest)
                        group['runs'].append(record)
                    save()
                if len(set(outputs)) != 1:
                    raise RuntimeError('seed/self frozen objects differ')
                summarize(group,'seed')
            except (RuntimeError,OSError,ValueError,subprocess.TimeoutExpired) as error:
                group['error']=str(error);report['failures'].append(f'{family}: {error}')
                print('ERROR',family,error,flush=True)
            save()
    report['status']='FAIL' if report['failures'] else 'PASS'
    save()
    return int(bool(report['failures']))


if __name__ == '__main__':
    raise SystemExit(main())
