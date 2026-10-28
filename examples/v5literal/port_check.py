#!/usr/bin/env python3
"""Source-inventory progress and mandatory final parity for the literal port."""
import argparse
import csv
import json
from pathlib import Path
import sys
import time

import clone_common as common
import clone_check
from port_inventory import digest, rust_syntax


def inventory():
    return json.loads((common.CONTROL / 'source-inventory.json').read_text())['sources']


def production_files():
    # Cargo's release library dep-info records files actually included in the
    # production crate. A cfg(test)-only or unregistered file cannot count.
    paths = set()
    for dep in (common.ROOT / 'obj/rust/release').glob('libcppgm_rust.d'):
        for word in dep.read_text().replace('\\\n', ' ').split():
            if word.endswith('.rs'):
                p = Path(word)
                paths.add((p if p.is_absolute() else common.ROOT / p).resolve())
    return paths


def review_complete(source, spec, included):
    root = common.ROOT
    file = root / spec['rust_path']
    if not file.is_file() or file.resolve() not in included:
        return False, 'mapped production file missing or not compiled'
    data = file.read_bytes()
    syntax = rust_syntax(data)
    review_file = root / 'port/reviews' / (source + '.json')
    try:
        review = json.loads(review_file.read_text())
        if review.get('source_sha256') != spec['sha256'] or review.get('rust_sha256') != digest(data):
            return False, 'source review does not match current bytes'
        if review.get('declarations_reviewed') is not True or review.get('state_lifetimes_reviewed') is not True:
            return False, 'declaration/state review missing'
        functions = review.get('functions', {})
        if set(functions) != {f['id'] for f in spec['functions']}:
            return False, 'original function correspondence is incomplete'
        rust_functions = {f['sha256'] for f in syntax['functions']}
        targets = [entry['rust_sha256'] for entry in functions.values()]
        if len(set(targets)) != len(targets) or not set(targets) <= rust_functions:
            return False, 'function targets must be distinct current production definitions'
        if set(review.get('manual_ranges', [])) != {r['id'] for r in spec['manual_ranges']}:
            return False, 'source parser gaps need explicit range review'
        if not isinstance(review.get('adaptations'), list) or not review.get('validation'):
            return False, 'adaptation list or validation receipt missing'
        for evidence in review['validation']:
            receipt = Path(evidence['path'])
            if not receipt.is_absolute():
                receipt = root / receipt
            if common.file_digest(receipt) != evidence['sha256']:
                return False, 'validation receipt changed'
            value = json.loads(receipt.read_text())
            if value['exit'] != 0 or value['source_files'].get(spec['rust_path']) != digest(data):
                return False, 'validation did not pass for this Rust file'
            if common.file_digest(Path(value['log'])) != value['log_sha256']:
                return False, 'validation raw log changed'
        if syntax['parse_error'] or not syntax['declarations']:
            return False, 'mapped file is empty or invalid'
    except (OSError, ValueError, KeyError, TypeError):
        return False, 'source review or raw validation evidence unavailable'
    return True, ''


def progress(*, summarize=True, quiet=False):
    sources = inventory()
    rows = list(csv.DictReader((common.ROOT / 'port/source-map.tsv').open(), delimiter='\t'))
    if len(rows) != len(sources) or {r['cpp_source'] for r in rows} != set(sources):
        raise RuntimeError('frozen source census changed')
    included = production_files()
    passed = 0
    if not quiet:
        print('===== pa33 =====')
    for row in rows:
        source = row['cpp_source']; spec = sources[source]
        done = False; why = 'pending translation'
        if row['status'] == 'complete':
            if row['rust_owner'] != spec['rust_path']:
                why = 'mapped source path changed'
            else:
                done, why = review_complete(source, spec, included)
        passed += done
        if not quiet:
            print(f'pa33/source/{source}: ' + ('PASS (1/1)' if done else 'FAIL (0/1)'))
        if row['status'] == 'complete' and not done:
            print(source + ': ' + why)
    if quiet:
        print(f'Literal source correspondence: {passed}/{len(sources)} current reviews')
    elif summarize:
        print(f'===== TEST SUMMARY: {passed} / {len(sources)} TESTS PASSED =====')
    return passed == len(sources)


def preflight():
    clone_check.preflight()
    local = common.ROOT / 'port/inventory.json'
    if local.read_bytes() != (common.CONTROL / 'source-inventory.json').read_bytes():
        raise RuntimeError('source definition inventory changed')
    print('Literal source inventory and routing: PASS')


def milestone_checks():
    stages = json.loads((common.ROOT / 'port/milestones.json').read_text()).get('stages', [])
    if len(set(stages)) != len(stages) or any(stage not in {f'pa{i}' for i in range(1, 34)} for stage in stages):
        raise RuntimeError('invalid course milestone inventory')
    for stage in sorted(stages, key=lambda x: int(x[2:])):
        clone_check.ACTIVE_STAGE = 33
        if not clone_check.stage_check(stage) or not clone_check.course(stage):
            return False
    print(f'Current recorded course milestones: {len(stages)} passed; all 33 remain mandatory at final acceptance')
    return True


def final():
    from clone_quality import checks
    if not progress() or checks():
        return False
    clone_check.ACTIVE_STAGE = 33
    if clone_check.completed_stages(33):
        return False
    return all(clone_check.course(stage, 'test-debuginfo') for stage in ('pa8', 'pa32', 'pa33'))


def record(command):
    if not command:
        raise ValueError('record needs a command after --')
    directory = common.ARTIFACTS / 'literal-validation' / str(time.time_ns())
    directory.mkdir(parents=True)
    before = {spec['rust_path']: common.file_digest(common.ROOT / spec['rust_path'])
              for spec in inventory().values() if (common.ROOT / spec['rust_path']).is_file()}
    code, out, err = common.run(command, timeout=1800)
    log = directory / 'command.log'; log.write_bytes(out + err)
    after = {name: common.file_digest(common.ROOT / name) for name in before if (common.ROOT / name).is_file()}
    if before != after:
        raise RuntimeError('source changed during recorded validation')
    receipt = {'kind': 'literal-validation', 'exit': code, 'command': command,
               'source_files': before, 'log': str(log), 'log_sha256': common.file_digest(log)}
    common.write_json(directory / 'receipt.json', receipt)
    sys.stdout.buffer.write(out + err)
    print('Validation receipt:', directory / 'receipt.json', flush=True)
    return code


def draft(source):
    """Generate bookkeeping only: flags stay false and evidence stays empty."""
    spec = inventory()[source]
    file = common.ROOT / spec['rust_path']
    data = file.read_bytes()
    functions = rust_syntax(data)['functions']
    aligned = len(functions) == len(spec['functions'])
    return {'source_sha256': spec['sha256'], 'rust_sha256': digest(data),
            'declarations_reviewed': False, 'state_lifetimes_reviewed': False,
            'functions': {original['id']: {'rust_sha256': functions[i]['sha256'] if aligned else '',
                                         'review_note': 'Proposed source-order mapping; verify original signature and body'}
                          for i, original in enumerate(spec['functions'])},
            'manual_ranges': [item['id'] for item in spec['manual_ranges']],
            'adaptations': [], 'validation': []}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['preflight', 'inventory', 'correspondence', 'final', 'milestones', 'inspect', 'draft', 'unsafe-scan', 'record'])
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.mode == 'record':
        return record(args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments)
    if args.mode in ('inspect', 'draft'):
        if len(args.arguments) != 1 or args.arguments[0] not in inventory():
            parser.error('inspect/draft requires one frozen C++ source path')
        if args.mode == 'draft':
            print(json.dumps(draft(args.arguments[0]), indent=2))
            return 0
        spec = inventory()[args.arguments[0]]
        file = common.ROOT / spec['rust_path']
        print(json.dumps({'source': args.arguments[0], **spec,
                          'rust': rust_syntax(file.read_bytes()) if file.exists() else None}, indent=2))
        return 0
    if args.mode == 'unsafe-scan':
        print(json.dumps({str(f.relative_to(common.ROOT)): rust_syntax(f.read_bytes())['unsafe']
                          for f in (common.ROOT / 'dev').rglob('*.rs') if rust_syntax(f.read_bytes())['unsafe']}, indent=2))
        return 0
    clone_check.build()
    preflight()
    if args.mode == 'preflight':
        return 0
    return 0 if {'inventory': progress, 'correspondence': lambda: progress(quiet=True),
                 'milestones': milestone_checks, 'final': final}[args.mode]() else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print('literal port gate error:', error, file=sys.stderr)
        sys.exit(2)
