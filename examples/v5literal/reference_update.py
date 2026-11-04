#!/usr/bin/env python3
"""Rebase a stopped literal translation's inputs without replacing its Rust work."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

from port_inventory import freeze_source

TOOLS = ('pptoken', 'posttoken', 'ppexpr', 'preproc', 'cppgm++', 'abimangle',
         'lowir', 'lowiropt', 'lowir2native')


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def census(reference, revision):
    names = git(reference, 'ls-tree', '-r', '--name-only', '-z', revision).decode().split('\0')
    return {'revision': revision, 'sources': {
        name: freeze_source(name, git(reference, 'show', revision + ':' + name))
        for name in names if name.startswith('dev/') and name.endswith(('.cpp', '.h'))}}


def classify(old, new, rows, previous=None):
    a, b = old['sources'], new['sources']
    changed = sorted(p for p in a.keys() & b.keys() if a[p]['sha256'] != b[p]['sha256'])
    unchanged = sorted(p for p in a.keys() & b.keys() if a[p]['sha256'] == b[p]['sha256'])
    complete = {row['cpp_source'] for row in rows if row['status'] == 'complete'}
    previous = previous or {}
    pending_recovery = (set(previous.get('recover', [])) - complete) & b.keys()
    recover = (complete & set(changed)) | pending_recovery
    baselines = previous.get('recovery_baselines', {})
    return {'old_revision': old['revision'], 'new_revision': new['revision'],
            'old_total': len(a), 'new_total': len(b), 'old_complete': len(complete),
            'added': sorted(b.keys() - a.keys()), 'removed': sorted(a.keys() - b.keys()),
            'changed': changed, 'unchanged': unchanged,
            'recover': sorted(recover),
            'previous_pending_recovery': sorted(pending_recovery),
            'recovery_baselines': {
                source: baselines.get(source, previous.get('old_revision', old['revision']))
                if source in pending_recovery else old['revision']
                for source in sorted(recover)},
            'preserve': sorted(complete & set(unchanged))}


def updated_rows(old_rows, new, report):
    complete = set(report['preserve'])
    old = {row['cpp_source']: row for row in old_rows}
    result = []
    for source, spec in new['sources'].items():
        if source in old and old[source]['rust_owner'] != spec['rust_path']:
            raise ValueError('unexpected mapped Rust path: ' + source)
        result.append({'cpp_source': source, 'rust_owner': spec['rust_path'],
                       'status': 'complete' if source in complete else 'pending'})
    return result


def reference_owned(name):
    # These inputs originate in extended, not the port. Keep literal controls,
    # launchers, Rust build files, reviews, journals and all Rust sources intact.
    return (name.startswith(('pa', 'shared/', 'benchmarks/'))
            or (name.startswith('scripts/') and not name.startswith('scripts/clone/')
                and name not in {'scripts/clone_check.py', 'scripts/clone_quality.py',
                                 'scripts/clone_evidence.py', 'scripts/port_check.py'})
            or name == 'dev/frontend_source_sets.mk')


def refresh_inputs(root, reference, old_revision, revision):
    # Use Git blobs and explicit modes; never follow an old destination symlink.
    sys.path.insert(0, str(root / 'scripts/clone'))
    from baseline_files import install_blob
    def tree(rev):
        entries = {}
        for record in git(reference, 'ls-tree', '-rz', rev).split(b'\0'):
            if not record:
                continue
            meta, name = record.split(b'\t', 1)
            mode, kind, oid = meta.decode().split()
            name = name.decode()
            if reference_owned(name):
                entries[name] = (mode, oid)
        return entries
    old, new = tree(old_revision), tree(revision)
    for name in old.keys() - new.keys():
        (root / name).unlink(missing_ok=True)
    for name, (mode, oid) in new.items():
        install_blob(root / name, mode, git(reference, 'cat-file', 'blob', oid))
    return new


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--assignment-revision', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    control, reference = args.control.resolve(), args.reference.resolve()
    settings = json.loads((control / 'settings.json').read_text())
    root = Path(settings['checkout'])
    state = json.loads((Path(settings['state_dir']) / 'state.json').read_text())
    if args.apply and (state.get('activeTurn') or {}).get('status') == 'running':
        raise RuntimeError('finish or interrupt the active turn before migration')
    if args.apply:
        config = control.parent / (control.name.removesuffix('-control') + '.config.json')
        processes = subprocess.check_output(['ps', '-eo', 'pid,args'], text=True)
        for line in processes.splitlines():
            if 'ralph.js' not in line or 'reference_update.py' in line:
                continue
            pid, command = line.strip().split(maxsplit=1)
            try:
                environment = Path('/proc', pid, 'environ').read_bytes().split(b'\0')
            except (OSError, PermissionError):
                environment = []
            if str(control) in command or str(config) in command or (
                    b'RALPH_CONFIG=' + str(config).encode() in environment):
                raise RuntimeError('stop the worker before migration')
    revision = git(reference, 'rev-parse', args.tag + '^{commit}').decode().strip()
    if git(reference, 'rev-parse', 'HEAD').decode().strip() != revision:
        raise RuntimeError('reference checkout must be at the requested tag')
    if git(reference, 'status', '--porcelain').strip() or (args.apply and git(root, 'status', '--porcelain').strip()):
        raise RuntimeError('candidate and reference must be clean')
    old = json.loads((control / 'source-inventory.json').read_text())
    new = census(reference, revision)
    with (root / 'port/source-map.tsv').open() as stream:
        rows = list(csv.DictReader(stream, delimiter='\t'))
    previous_file = root / 'port/reference-update.json'
    previous = json.loads(previous_file.read_text()) if previous_file.exists() else None
    report = classify(old, new, rows, previous)
    report.update(assignment_revision=args.assignment_revision, tag=args.tag,
                  previous_reference=settings['reference'], reference=str(reference),
                  candidate_before=git(root, 'rev-parse', 'HEAD').decode().strip())
    print(json.dumps({k: len(v) if isinstance(v, list) else v for k, v in report.items()}, indent=2))
    if not args.apply:
        return
    namespace = args.tag + '-' + revision[:12]
    backup = Path(settings['artifacts']).parent / ('reference-update-' + namespace)
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copytree(control, backup / 'control', ignore=shutil.ignore_patterns('venv', '__pycache__'))
    shutil.copytree(root / 'port', backup / 'port')
    shutil.copytree(root / 'docs/port', backup / 'docs-port')
    shutil.copy2(Path(settings['state_dir']) / 'state.json', backup / 'state.json')
    write_json(backup / 'report.json', report)
    frozen = json.loads((control / 'manifest.json').read_text())
    tracked = git(reference, 'ls-files', '-z').decode().split('\0')[:-1]
    # Verify the new oracle before changing the active protected pins.
    oracle_tools = {tool: sha(reference / 'dev' / tool) for tool in TOOLS}
    for directory in (control, root / 'scripts/clone'):
        updated = dict(settings, reference=str(reference), revision=revision,
                       assignment_revision=args.assignment_revision, assignment_tag=args.tag,
                       artifacts=str(Path(settings['artifacts']).parent / ('clone-' + namespace)))
        write_json(directory / 'settings.json', updated)
        Path(updated['artifacts']).mkdir(parents=True, exist_ok=True)
    new_inputs = refresh_inputs(root, reference, old['revision'], revision)
    for destination in (control / 'source-inventory.json', root / 'port/inventory.json'):
        write_json(destination, new)
    with (root / 'port/source-map.tsv').open('w') as stream:
        writer = csv.DictWriter(stream, fieldnames=['cpp_source', 'rust_owner', 'status'],
                                delimiter='\t', lineterminator='\n')
        writer.writeheader()
        writer.writerows(updated_rows(rows, new, report))
    # Preserve old review documents for actual diff-based recovery; their old
    # source hashes do not certify changed sources against the new inventory.
    milestone_file = root / 'port/milestones.json'
    milestones = json.loads(milestone_file.read_text())
    if 'current_validation' in milestones:
        milestones.setdefault('historical_validation', []).append(milestones.pop('current_validation'))
    if 'partial_readiness' in milestones:
        milestones.setdefault('historical_partial_readiness', []).append({
            'revision': old['revision'], 'readiness': milestones.pop('partial_readiness')})
    milestones['reference_update'] = {'revision': revision, 'needs_revalidation': milestones['stages']}
    write_json(milestone_file, milestones)
    write_json(root / 'port/reference-update.json', report)
    for directory in (root / 'obj/bootstrap',):
        if directory.exists():
            shutil.move(str(directory), str(backup / 'bootstrap'))
    (root / 'docs/port/pa33.md').write_text(f'''# Whole-source translation ledger

Reference update to {args.tag}: `{old['revision'][:12]}` -> `{revision[:12]}`.
Prior candidate tip: `{report['candidate_before']}`. Previous ledger and raw
evidence are retained at `{backup}` and the prior Git history.

The current inventory has {len(new['sources'])} sources. {len(report['preserve'])}
previously completed sources are byte-identical; {len(report['recover'])} sources
require recovery (including {len(report['previous_pending_recovery'])} carried
from the prior update), and {len(report['added'])} new sources are
pending. Existing Rust implementation, reviews and unsafe records are retained.
Changed C++ sources are pending; an old review never certifies new source bytes.

Read `port/reference-update.json`. First recover changed completed files in
dependency groups, using each file's `recovery_baselines` revision with
`git -C {reference} diff OLD {revision} -- dev/path.cpp` and
`make inspect SOURCE=dev/path.cpp`. Update affected Rust
declarations and consumers together, preserving the new source algorithms and
lifetimes. Use existing tests and current source diffs; do not replay historical
audits wholesale or redesign the compiler. Renew only affected source reviews
and evidence after a coherent batch builds and focused comparisons pass.

Revalidate usable milestones {', '.join(milestones['stages'])} against the new
oracle as their affected owners recover. Old success is historical, not current
V8 parity. Then resume unfinished translation in dependency order. All PA1–PA33
comparisons/course/debug checks and PA34 C1==C2==CR==C3 remain mandatory at final
closure; this reference update does not claim they pass.
''')
    protected = {name: sha(root / name) for name in frozen['protected']
                 if not reference_owned(name) and (root / name).is_file()}
    protected.update({name: sha(root / name) for name in new_inputs
                      if (root / name).is_file()})
    frozen.update(revision=revision, assignment_revision=args.assignment_revision,
                  assignment_tag=args.tag, protected=protected,
                  source_responsibilities=list(new['sources']), oracle_tools=oracle_tools,
                  oracle_sources={name: sha(reference / name) for name in tracked
                                  if name.startswith('dev/') and (reference / name).is_file()},
                  stages={f'pa{n}': [name[len(f'pa{n}/'):] for name in tracked
                                    if name.startswith(f'pa{n}/tests/') and name.endswith('.t')
                                    and '/debuginfo/' not in name] for n in range(1, 34)})
    for destination in (control / 'manifest.json', root / 'scripts/clone/manifest.json'):
        write_json(destination, frozen)
    print('Inputs migrated; old Rust bytes/reviews retained. Commit and run fresh startup checks.')


if __name__ == '__main__':
    main()
