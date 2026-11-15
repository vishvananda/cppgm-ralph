#!/usr/bin/env python3
"""Prepare or apply the unstarted V8-to-V9 student migration after release export."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
TEMPLATES = REPO / 'examples/v9sol'
module = importlib.util.spec_from_file_location('release_inputs', HERE / 'release-inputs.py')
release = importlib.util.module_from_spec(module)
module.loader.exec_module(release)
OLD_BASE = '639031a9a0cdd690ef9f949efdab055d433d4638'


def run(command, **kwargs):
    return subprocess.run(list(map(str, command)), check=True, **kwargs)


def plan(work, source, assignments):
    # Verify release provenance before touching run files, config or state.
    pins = release.verify_release(source, assignments)
    old = json.loads((work / 'v8sol.config.json').read_text())
    root = (work / 'v8sol').resolve(strict=True)
    if release.git(root, 'status', '--porcelain'):
        raise ValueError('V8 scaffold must be clean')
    for name in ['v8sol', 'v9sol']:
        state = Path(old['stateBaseDir']) / f"{name}-{old['model']}-{old['reasoningEffort']}"
        if (state / 'state.json').exists():
            raise ValueError('migration is only for unstarted scaffolds: ' + str(state))
    if (work / 'v9sol').exists() or (work / 'v9sol.config.json').exists():
        raise ValueError('V9 destination already exists')
    changed = release.git(root, 'diff', '--name-only', OLD_BASE, 'HEAD').splitlines()
    if any(name != 'spec.md' for name in changed):
        raise ValueError('V8 contains work beyond its spec preparation; preserve it explicitly first')
    config = json.loads((TEMPLATES / 'v9sol.config.json').read_text())
    config.update(baseDir=str(work), workdir=str(work / 'v9sol'), stateBaseDir=old['stateBaseDir'])
    # Reuse the mounted filesystem. Renaming an LVM mount is unnecessary and
    # would invalidate its fstab and sandbox bind paths.
    config['sessionIsolation']['privateWriteDir'] = old['sessionIsolation']['privateWriteDir']
    config['sourceRelease'].update(assignmentsRevision=pins['assignments_revision'])
    return {'pins': pins, 'old_checkout': str(root), 'old_tip': release.git(root, 'rev-parse', 'HEAD'),
            'old_remote': release.git(root, 'remote', 'get-url', 'origin'),
            'new_remote': 'git@github.com:vishvananda/cppgm-run-v9sol.git', 'config': config,
            'storage_note': 'Existing V8 mounted storage is retained; public run/config/state identity becomes V9.'}


def prepare(report, output):
    output.mkdir(parents=True, exist_ok=False)
    checkout = output / 'checkout'
    run(['git', 'clone', '--no-hardlinks', report['old_checkout'], checkout])
    run(['git', 'fetch', report['pins']['assignments_repository'], report['pins']['assignments_revision']], cwd=checkout)
    # Retain the old preparation history and merge the exact export; only spec
    # differs from that export. This keeps a normal fast-forward remote push.
    merged = subprocess.run(['git', 'merge', '--no-commit', '--no-ff', report['pins']['assignments_revision']], cwd=checkout)
    conflicts = release.git(checkout, 'diff', '--name-only', '--diff-filter=U').splitlines()
    if any(name != 'spec.md' for name in conflicts) or (merged.returncode and not conflicts):
        raise ValueError('unexpected assignment merge conflict: ' + ', '.join(conflicts))
    shutil.copy2(TEMPLATES / 'spec.md', checkout / 'spec.md')
    run(['git', 'add', 'spec.md'], cwd=checkout)
    run(['git', 'commit', '-m', 'Configure V9 Sol from the v0.9.0 assignment export'], cwd=checkout)
    difference = release.git(checkout, 'diff', '--name-only', report['pins']['assignments_revision'], 'HEAD').splitlines()
    if difference != ['spec.md']:
        raise ValueError('prepared checkout must differ from the release only in spec.md: ' + repr(difference))
    for p in TEMPLATES.glob('v9sol.*.md'):
        shutil.copy2(p, output / p.name)
    (output / 'v9sol.config.json').write_text(json.dumps(report['config'], indent=2) + '\n')
    run(['node', TEMPLATES / 'verify-setup.mjs', output / 'v9sol.config.json'])
    report['new_tip'] = release.git(checkout, 'rev-parse', 'HEAD')
    (output / 'migration.json').write_text(json.dumps(report, indent=2) + '\n')
    return checkout


def apply(report, output, checkout, work):
    # Recheck mutable boundaries before external or installed-state changes.
    if release.git(report['old_checkout'], 'rev-parse', 'HEAD') != report['old_tip']:
        raise ValueError('old scaffold changed during preparation')
    if release.git(report['old_checkout'], 'status', '--porcelain'):
        raise ValueError('old scaffold acquired local changes')
    if Path(report['old_checkout']).with_name('checkout-v8-archive').exists():
        raise ValueError('V8 archive already exists')
    if (work / 'v9sol').exists() or (work / 'v9sol.config.json').exists():
        raise ValueError('V9 destination appeared during preparation')
    old_repo = re.search(r'github.com[:/]([^/]+/[^/]+?)(?:\.git)?$', report['old_remote'])
    if not old_repo or old_repo[1] != 'vishvananda/cppgm-run-v8sol':
        raise ValueError('unexpected V8 remote; review repository migration explicitly')
    run(['gh', 'api', '--method', 'PATCH', 'repos/' + old_repo[1], '-f', 'name=cppgm-run-v9sol'], stdout=subprocess.DEVNULL)
    run(['git', 'remote', 'set-url', 'origin', report['new_remote']], cwd=checkout)
    # The clone's upstream may still be the V8 export remote.
    if 'upstream' in release.git(checkout, 'remote').splitlines():
        run(['git', 'remote', 'set-url', 'upstream', 'git@github.com:vishvananda/cppgm-assignments.git'], cwd=checkout)
    else:
        run(['git', 'remote', 'add', 'upstream', 'git@github.com:vishvananda/cppgm-assignments.git'], cwd=checkout)
    run(['git', 'push', '-u', 'origin', 'HEAD:main'], cwd=checkout)
    old_root = Path(report['old_checkout'])
    archive = old_root.with_name('checkout-v8-archive')
    if archive.exists():
        raise ValueError('V8 archive already exists')
    old_root.rename(archive)
    shutil.move(str(checkout), old_root)
    (work / 'v9sol').symlink_to(old_root, target_is_directory=True)
    for p in output.glob('v9sol.*'):
        shutil.copy2(p, work / p.name)
    (output / 'old-sidecars').mkdir()
    for p in work.glob('v8sol.*'):
        shutil.move(str(p), output / 'old-sidecars' / p.name)
    (work / 'v8sol').unlink()
    print('V9 installed and pushed; V8 checkout/sidecars archived; no state created and no worker started.')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--assignments', type=Path, required=True)
    p.add_argument('--work-base', type=Path, default=Path.home() / 'work')
    p.add_argument('--output', type=Path, required=True, help='fresh staging directory on the retained private filesystem for --apply')
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    work = args.work_base.resolve()
    report = plan(work, args.source, args.assignments)
    if args.apply:
        storage = Path(report['config']['sessionIsolation']['privateWriteDir']).resolve()
        if not args.output.resolve().is_relative_to(storage):
            raise ValueError('--apply output must be on the retained private filesystem')
    if any(args.output.resolve().is_relative_to(path) for path in
           [Path(report['old_checkout']), args.source.resolve(), args.assignments.resolve()]):
        raise ValueError('staging output must be outside the existing and reference checkouts')
    checkout = prepare(report, args.output.resolve())
    if args.apply:
        apply(report, args.output.resolve(), checkout, work)
    else:
        print('Prepared only:', args.output, '\nExisting V8 run is untouched. Review migration.json before --apply with a fresh output directory.')


if __name__ == '__main__':
    main()
