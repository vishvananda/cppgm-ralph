#!/usr/bin/env python3
"""Stage the existing literal Rust port against the exact V9 release; never start it."""
import argparse
import csv
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO / 'examples/v5literal'))
from reference_update import census, classify, source_renames, release_layout, refresh_inputs, reference_owned, sha


def load_release():
    spec = importlib.util.spec_from_file_location('release_inputs', HERE / 'release-inputs.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def stage(control, source, assignments, output, release_options=None):
    release = load_release()
    pins = release.verify_release(source, assignments, **(release_options or {}))
    settings = json.loads((control / 'settings.json').read_text())
    original = Path(settings['checkout'])
    if git(original, 'status', '--porcelain'):
        raise ValueError('existing Rust checkout must be clean')
    state_file = Path(settings['state_dir']) / 'state.json'
    if state_file.exists() and (json.loads(state_file.read_text()).get('activeTurn') or {}).get('status') == 'running':
        raise ValueError('stop the worker before staging migration')
    if git(source, 'rev-parse', 'HEAD') != pins['source_revision'] or git(source, 'status', '--porcelain'):
        raise ValueError('new C++ oracle checkout must be clean and at the release')
    layout = release_layout(source, pins['source_revision'])
    if layout['id'] != 'v9' or 'pa38' not in layout['correctness_stages']:
        raise ValueError('V9 port profile must include C')
    if any(output.is_relative_to(path.resolve()) for path in [original, control, source, assignments]):
        raise ValueError('staging output must be outside the active and reference checkouts')
    output.mkdir(parents=True, exist_ok=False)
    root, target_control = output / 'checkout', output / 'control'
    subprocess.run(['git', 'clone', '--no-hardlinks', str(original), str(root)], check=True)
    subprocess.run(['git', 'checkout', '-b', 'migration/' + pins.get('source_tag', 'v9')], cwd=root, check=True)
    subprocess.run(['git', 'remote', 'set-url', 'origin', git(original, 'remote', 'get-url', 'origin')], cwd=root, check=True)
    shutil.copytree(control, target_control, ignore=shutil.ignore_patterns('venv', '__pycache__'))
    (target_control / 'venv').symlink_to(control / 'venv', target_is_directory=True)
    old_inventory = json.loads((control / 'source-inventory.json').read_text())
    new_inventory = census(source, pins['source_revision'])
    with (root / 'port/source-map.tsv').open() as stream:
        rows = list(csv.DictReader(stream, delimiter='\t'))
    previous = json.loads((root / 'port/reference-update.json').read_text())
    report = classify(old_inventory, new_inventory, rows, previous,
                      source_renames(source, old_inventory['revision'], pins['source_revision']))
    report.update(course_layout=layout, release=pins, candidate_before=git(original, 'rev-parse', 'HEAD'),
                  required_scope='All supported V9 source features, including optional-course PA38 C, wasm and LowIR interfaces; exact output and <=5% frozen compile-time gap.')
    # Tests and wrappers must come from the tagged student export, not source
    # checkout wrappers which assume C++ implementation files under dev/.
    new_inputs = refresh_inputs(root, assignments, settings['assignment_revision'], pins['assignments_revision'])
    for old_path, new_path in report['rust_relocations'].items():
        before, after = root / old_path, root / new_path
        if not before.is_file() or after.exists():
            raise ValueError('unexpected Rust relocation: ' + old_path)
        after.parent.mkdir(parents=True, exist_ok=True)
        before.rename(after)
        registry = root / 'dev/src/translated/mod.rs'
        old_relative = str(Path(old_path).relative_to('dev/src/translated'))
        new_relative = str(Path(new_path).relative_to('dev/src/translated'))
        data = registry.read_text()
        if old_relative not in data:
            raise ValueError('production registry does not contain relocated owner: ' + old_relative)
        registry.write_text(data.replace(old_relative, new_relative))
    ledger = json.loads((root / 'port/unsafe.json').read_text())
    for entry in ledger['entries']:
        if entry['file'] in report['rust_relocations']:
            entry['file'] = report['rust_relocations'][entry['file']]
    write(root / 'port/unsafe.json', ledger)
    for before, after in report['renamed'].items():
        old_review, new_review = root / 'port/reviews' / (before + '.json'), root / 'port/reviews' / (after + '.json')
        if old_review.exists():
            new_review.parent.mkdir(parents=True, exist_ok=True)
            old_review.rename(new_review)  # Still pending: no hash or completion is certified.
    updated_settings = settings | {'checkout': str(root), 'reference': str(source),
        'artifacts': str(output / 'artifacts'), 'state_dir': str(output / 'state'),
        'revision': pins['source_revision'], 'assignment_revision': pins['assignments_revision'],
        'assignment_tag': pins['assignments_tag'], 'course_layout': layout}
    common_files = ['clone_common.py', 'clone_check.py', 'clone_adapter.py', 'clone_bootstrap.py',
                    'clone_bootstrap_probe.py', 'clone_evidence.py']
    literal_files = ['port_check.py', 'reference_update.py']
    for destination in [target_control, root / 'scripts/clone']:
        for name in common_files:
            shutil.copy2(REPO / 'examples/v5rust' / name, destination / name)
        for name in literal_files:
            shutil.copy2(REPO / 'examples/v5literal' / name, destination / name)
        write(destination / 'settings.json', updated_settings)
        write(destination / 'source-inventory.json' if destination == target_control else destination / 'inventory.json', new_inventory)
    write(root / 'port/inventory.json', new_inventory)
    # Rebind copied launchers only; authentication and Ralph state are not copied.
    for directory in [target_control / 'bin', root / 'scripts']:
        paths = directory.iterdir() if directory.name == 'bin' else [directory / name for name in
            ['clone_check.py', 'clone_quality.py', 'clone_evidence.py', 'port_check.py']]
        for path in paths:
            if path.is_file() and not path.is_symlink():
                data = path.read_text()
                path.write_text(data.replace(str(control), str(target_control)))
    (target_control / 'bin/cppgm++').unlink(missing_ok=True)
    wrapper = target_control / 'bin/cppgm'
    wrapper.write_text(f'#!/bin/sh\nexec python3 "{target_control}/clone_adapter.py" "cppgm" "$@"\n')
    wrapper.chmod(0o755)
    (root / 'dev/cppgm++').unlink(missing_ok=True)
    (root / 'dev/cppgm++-ref').unlink(missing_ok=True)
    driver = root / 'dev/cppgm'
    driver.unlink(missing_ok=True)
    driver.symlink_to('../obj/rust/release/cppgm')
    tools = ['pptoken', 'posttoken', 'ppexpr', 'preproc', 'cppgm', 'abimangle', 'lowir', 'lowiropt', 'lowir2native']
    for tool in tools:
        oracle = root / 'dev' / (tool + '-ref')
        oracle.unlink(missing_ok=True)  # Never follow an old oracle symlink.
        oracle.write_text(f'#!/bin/sh\nexec "{source}/dev/{tool}" "$@"\n')
        oracle.chmod(0o755)
    dev_make = root / 'dev/Makefile'
    dev_make.write_text(dev_make.read_text().replace('cppgm++', 'cppgm'))
    makefile = root / 'Makefile'
    makefile.write_text(makefile.read_text().replace(str(control), str(target_control))
                        .replace('EXPERIMENTAL_PAS ?= pa34 pa35', 'EXPERIMENTAL_PAS ?= pa34 pa35 pa36 pa38'))
    with (root / 'port/source-map.tsv').open('w') as stream:
        writer = csv.DictWriter(stream, fieldnames=['cpp_source', 'rust_owner', 'status'], delimiter='\t', lineterminator='\n')
        writer.writeheader()
        from reference_update import updated_rows
        writer.writerows(updated_rows(rows, new_inventory, report))
    write(root / 'port/reference-update.json', report)
    milestones = json.loads((root / 'port/milestones.json').read_text())
    milestones['historical_v8'] = dict(milestones)
    milestones['stages'] = []
    for key in ['current_validation', 'partial_readiness']:
        milestones.pop(key, None)
    milestones['reference_update'] = {'revision': pins['source_revision'], 'needs_revalidation': layout['correctness_stages']}
    write(root / 'port/milestones.json', milestones)
    # Current instructions must agree with the new release before any worker
    # is resumed. Historical measurement reports stay untouched.
    for name in ['AGENTS.md', 'CLONE_CONTRACT.md', 'spec.md', 'porting.md', 'README.md']:
        path = root / name
        if not path.exists():
            continue
        text = path.read_text().replace('PA34', 'PA35').replace('PA1–PA33', 'PA1–PA34, PA37 and PA38')
        text = text.replace('cppgm++', 'cppgm').replace('PA35 is outside this run.', 'PA36 measures compiler performance.').replace('PA35 is excluded.', 'PA36 measures compiler performance separately.').replace('No PA35 optimization target.',
            'Compare V9 frozen compile performance against the pinned C++ compiler.')
        if name in ['AGENTS.md', 'CLONE_CONTRACT.md', 'spec.md']:
            text += '\nV9 scope includes the full pinned C++ implementation, its supported native/wasm\n'
            text += 'targets and PA38 C features. PA38 is mandatory for this Rust port. The source\n'
            text += 'inventory uses PA33 only as its transport label; PA35 proves bootstrap and\n'
            text += 'PA36 supplies performance workloads. The frozen O0/O3 compile-time gap must\n'
            text += 'stay within 5%; no reference fallback or changed comparison policy.\n'
        path.write_text(text)
    frozen = json.loads((target_control / 'manifest.json').read_text())
    tracked = git(source, 'ls-files', '-z').split('\0')
    frozen.update(revision=pins['source_revision'], assignment_revision=pins['assignments_revision'],
        assignment_tag=pins['assignments_tag'], source_responsibilities=list(new_inventory['sources']),
        course_layout=layout, oracle_tools={tool: sha(source / 'dev' / tool) for tool in
            ['pptoken', 'posttoken', 'ppexpr', 'preproc', 'cppgm', 'abimangle', 'lowir', 'lowiropt', 'lowir2native']},
        oracle_sources={name: sha(source / name) for name in tracked if name.startswith('dev/') and (source / name).is_file()},
        stages={name: [path[len(name) + 1:] for path in new_inputs if path.startswith(name + '/tests/')
                       and path.endswith('.t') and '/debuginfo/' not in path] for name in layout['correctness_stages']})
    frozen['protected'] = {name: sha(root / name) for name in frozen['protected']
                           if not reference_owned(name) and (root / name).is_file()}
    frozen['protected'].update({name: sha(root / name) for name in new_inputs if (root / name).is_file()})
    frozen['protected'].update({'dev/' + tool + '-ref': sha(root / 'dev' / (tool + '-ref')) for tool in tools})
    for destination in [target_control, root / 'scripts/clone']:
        for name in [*common_files, *literal_files, 'settings.json']:
            frozen['protected']['scripts/clone/' + name] = sha(root / 'scripts/clone' / name)
    for destination in [target_control / 'manifest.json', root / 'scripts/clone/manifest.json']:
        write(destination, frozen)
    (root / 'docs/port').mkdir(parents=True, exist_ok=True)
    (root / 'docs/port/pa33.md').write_text(f'''# V9 source recovery ledger

Pinned source `{pins['source_revision']}`, assignments `{pins['assignments_revision']}`.
The Rust implementation is retained from `{report['candidate_before']}`; no V9
parity is claimed. Recover {len(report['recover'])} existing owners and implement
new owners from `port/reference-update.json`, following each original source and
its producer/consumer dependencies. Rename origins and original diff baselines
are explicit. Retire removed owners after their replacements are recovered.

PA33 is only the source-inventory transport label. Final correctness includes
PA1–34, PA37 wasm and PA38 C; PA35 is bootstrap. Include all shipped LowIR
interfaces. Retain exact errors, counters, objects and complete bootstrap proof.
Performance targets the V9 C++ reference on frozen and full self-compiles,
with a <=5% frozen O0/O3 wall gap and controlled counters. Preserve all earlier
memory/error/cleanup guarantees; no source or checker fallback. The worker is
unstarted and no new review is certified by preparation.
''')
    frozen['protected'] = {name: sha(root / name) for name in frozen['protected']}
    for destination in [target_control / 'manifest.json', root / 'scripts/clone/manifest.json']:
        write(destination, frozen)
    write(output / 'migration.json', report)
    print(json.dumps({'prepared_checkout': str(root), 'control': str(target_control),
                      'recover': len(report['recover']), 'sources': len(new_inventory['sources']), 'active_run_changed': False,
                      'required_port_stages': layout['correctness_stages'], 'worker_started': False}, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--control', type=Path, default=Path.home() / 'work/v5literal-control')
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--assignments', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    release = load_release()
    release.arguments(p)
    args = p.parse_args()
    stage(args.control.resolve(), args.source.resolve(), args.assignments.resolve(), args.output.resolve(), release.options(args))


if __name__ == '__main__':
    main()
