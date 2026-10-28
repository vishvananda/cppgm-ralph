#!/usr/bin/env python3
"""Create a fresh source-driven port; never copy another Rust implementation."""
import argparse
import csv
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

from port_inventory import freeze_source

HERE = Path(__file__).resolve().parent
BASE_EXAMPLE = HERE.parent / 'v5rust'
REVISION = '22cd2cd17f660b765c8118e9675fab676daec714'
ASSIGNMENTS = '829dd5d2c7e5abba72ce5e58985e15e6bb6576c2'
NAME = 'v5literal'


def load_base():
    spec = importlib.util.spec_from_file_location('clone_scaffold', BASE_EXAMPLE / 'scaffold.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prompts(base, control):
    implement = '''Translate the next finite frozen C++ source dependency batch into Rust.

{{briefState}}
Inventory status: {{testStatusSummary}}
Primary log: {{lastTestLogPath}}

Read AGENTS.md, CLONE_CONTRACT.md, spec.md, porting.md and the compact current
ledger. PA33 is the whole-source inventory label, not an assignment feature task.
Use the frozen C++ files directly. Preserve functions, fields, control flow,
persistent state, failure restoration, lazy/short-circuit order, live queues and
cache boundaries. Record Rust-required representation adaptations; defer optional
redesign, abstractions and optimization. Keep the frozen per-file mapping.

Start with a shared pointer/arena/null/error/integer convention, then translate
in dependency order. Pending declarations/stubs may help compilation but do not
count as implemented. Use make inspect SOURCE=dev/path.cpp to map every function.
Unsafe needs SAFETY explanations, a precise ledger and valid alias/lifetime rules.
Never call C++ implementation code or substitute oracle answers/objects.

Validate a coherent batch with make build, make lint and make audit-rust; record
successful commands through scripts/clone/port_check.py record -- COMMAND.
Use focused differential cases and original course milestones when tools are
usable. Reuse controls, run broad suites at stable milestones/final closure and
use bounded frozen-source probes to prioritize the first real divergence.
Original tests, diagnostics, work counters and generated files remain exact.

Fill current whole-source reviews and function correspondence, then mark only
fully translated/reviewed source rows complete. Keep one ledger: batch, reviewed
tip, mappings/adaptations, findings, evidence and next dependency. Commit and
leave clean. Complete Ralph's existing bounded handoff goal and return; the
compiler may remain incomplete. No goal reset, protected-policy or Ralph-state edit.

{{modelValidation}}
'''
    audit = implement.replace('Translate the next finite frozen C++ source dependency batch into Rust.',
        'Independently review the completed frozen-source batch and close concrete translation gaps.')
    audit = audit.replace('Start with a shared pointer/arena/null/error/integer convention, then translate\nin dependency order.',
        'Review all changed source mappings since the recorded reviewed tip. Trace\noriginal branches, state lifetimes and queue/cache boundaries, not just fixtures.')
    audit += '\nFinal advancement requires the complete inventory, all PA1–PA33 differential/course/debug lanes and full Rust quality. PA34 then proves clean C1==C2==CR==C3; partial probes never satisfy it.\n'
    goal = '''Complete one finite source-faithful translation/review handoff. Follow the
frozen file/function mapping, preserve algorithms and execution lifetimes, and
record only Rust-required adaptations. Validate the changed group and unsafe
invariants, close only fully reviewed source responsibilities, update the compact
ledger, commit and leave clean. Partial completion ends this handoff, not the
compiler. Complete Ralph's existing native goal; do not reset goals or weaken
the source inventory, exact comparator or final course/bootstrap requirements.

{{modelValidation}}
'''
    for phase, text in [('implement', implement), ('checkpointAudit', audit), ('audit', audit)]:
        for suffix, body in [(phase, text), (phase + '-goal', goal)]:
            filename = NAME + '.' + suffix + '.md'
            for directory in (base, control, HERE):
                (directory / filename).write_text(body)
    for phase in ('implement', 'audit'):
        original = (BASE_EXAMPLE / f'v5rust.pa34-{phase}.md').read_text()
        original = original.replace('Read CLONE_CONTRACT.md\'s PA34 proof, docs/rust-clone-plan.md and the frozen',
                                    'Read CLONE_CONTRACT.md\'s PA34 proof, porting.md and the frozen')
        original = original.replace('Rust quality checks', 'literal Rust quality checks')
        for suffix, body in [(f'pa34-{phase}', original), (f'pa34-{phase}-goal', goal)]:
            for directory in (base, control, HERE):
                (directory / (NAME + '.' + suffix + '.md')).write_text(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=Path('/home/vishvananda/work'))
    args = parser.parse_args()
    base = args.base.resolve(); private = base / 'private' / NAME
    root = private / 'checkout'; reference = base / 'references' / (NAME + '-cpp')
    control = base / (NAME + '-control')
    for path in (root, base / NAME, base / (NAME + '.config.json')):
        if path.exists() or path.is_symlink():
            raise RuntimeError(f'refusing to overwrite {path}')
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=reference, text=True).strip()
    if actual != REVISION:
        raise RuntimeError('reference is not the pinned source revision')
    module = load_base()
    module.BASE, module.PRIVATE, module.ROOT = base, private, root
    module.REFERENCE, module.CONTROL = reference, control
    module.REVISION, module.ASSIGNMENT_REVISION = REVISION, ASSIGNMENTS
    root.mkdir(); control.mkdir(exist_ok=True)
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=reference).decode().split('\0')[:-1]
    for name in tracked:
        if name.startswith(('dev/', 'docs/', '.github/')) and name != 'dev/frontend_source_sets.mk':
            continue
        source, target = reference / name, root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            target.symlink_to(source.readlink())
        else:
            shutil.copy2(source, target)
    module.workspace()
    cargo = root / 'dev/Cargo.toml'
    text = cargo.read_text().replace('unsafe_code = "forbid"', 'unsafe_code = "allow"\nunsafe_op_in_unsafe_fn = "deny"')
    start = text.index('[workspace.lints.clippy]'); end = text.index('[[bin]]', start)
    text = text[:start] + '''[workspace.lints.clippy]
all = { level = "allow", priority = -1 }
correctness = "deny"
undocumented_unsafe_blocks = "deny"
missing_safety_doc = "deny"

''' + text[end:]
    cargo.write_text(text)
    for directory in (root / 'dev/src').iterdir():
        if directory.is_dir() and directory.name != 'driver':
            shutil.rmtree(directory)
    module.write(root / 'dev/src/lib.rs', '''//! Literal translation of the pinned C++ compiler.
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, dead_code, unused_imports)]
pub mod compat;
pub mod driver;
pub mod translated;
''')
    module.write(root / 'dev/src/compat/mod.rs', '//! Shared Rust-required representations; review ownership and unsafe before use.\n')
    module.write(root / 'dev/src/translated/mod.rs', '//! Register the frozen per-file translations here; pending stubs do not count.\n')
    for source, filename in (('candidate-AGENTS.md', 'AGENTS.md'), ('spec.md', 'spec.md'), ('CLONE_CONTRACT.md', 'CLONE_CONTRACT.md')):
        shutil.copy2(HERE / source, root / filename)
    module.controls()
    for directory in (control, root / 'scripts/clone'):
        settings = json.loads((directory / 'settings.json').read_text())
        settings['source_map_path'] = 'port/source-map.tsv'
        module.json_file(directory / 'settings.json', settings)
    module.write(root / 'scripts/port_check.py', f'''#!/usr/bin/env python3
import os
import sys
os.execv("{control}/venv/bin/python", ["{control}/venv/bin/python", "{control}/port_check.py", *sys.argv[1:]])
''')
    # Keep the exact comparator/bootstrap and their regressions. The literal
    # quality/audit replace the safe/idiomatic-port policy, not comparison rules.
    for directory in (control, root / 'scripts/clone'):
        for file in HERE.glob('*.py'):
            if file.name != 'scaffold.py':
                shutil.copy2(file, directory / file.name)
    source_inventory = {'revision': REVISION, 'sources': {
        source: freeze_source(source, (reference / source).read_bytes())
        for source in tracked if source.startswith('dev/') and source.endswith(('.cpp', '.h'))}}
    for destination in (control / 'source-inventory.json', root / 'port/inventory.json'):
        module.json_file(destination, source_inventory)
    (root / 'port/reviews').mkdir()
    module.json_file(root / 'port/unsafe.json', {'entries': []})
    module.json_file(root / 'port/milestones.json', {'stages': []})
    (root / 'docs/port').mkdir(parents=True)
    with (root / 'port/source-map.tsv').open('w') as file:
        writer = csv.writer(file, delimiter='\t', lineterminator='\n')
        writer.writerow(['cpp_source', 'rust_owner', 'status'])
        writer.writerows((source, spec['rust_path'], 'pending') for source, spec in source_inventory['sources'].items())
    module.write(root / 'porting.md', (HERE / 'porting.md').read_text())
    module.write(root / 'docs/port/pa33.md', '''# Whole-source translation ledger

Inventory: 0/408 complete. No C++ compiler implementation has been translated.
PA33 is a Ralph transport label, not assignment progress. See porting.md.

First batch: inspect original shared storage/identity/ownership types and their
users. Establish the minimal Rust compatibility conventions while retaining C++
lifetimes and aliasing. Record necessary adaptations and unsafe invariants before
using them in source translations. Then select a finite low-level dependency
batch and translate original files/functions without redesign.

All candidate tools currently return the explicit scaffold status 86. Reference
tools are separate; their success never proves candidate implementation. No course
milestone, source review or bootstrap proof is accepted. Keep this ledger compact.
''')
    module.write(root / 'docs/port/pa34.md', '# Bootstrap ledger\n\nPending complete source translation and all course/debug validation.\n')
    module.write(root / 'README.md', (HERE / 'candidate-README.md').read_text())
    workflow = root / 'ci/rust.yml'
    workflow.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / 'rust.yml', workflow)
    checkpoint = f'python3 {control}/clone_check.py'
    port = f'{control}/venv/bin/python {control}/port_check.py'
    quality = f'python3 {control}/clone_quality.py'
    makefile = f'''# Source-driven translation. Course PA directories are validation material.
EXPERIMENTAL_PAS ?= pa34 pa35
export CARGO_HOME := $(abspath ../cache/cargo)
export CARGO_TARGET_DIR := $(CURDIR)/obj/rust
export CPPGM_BUILD_HOST_CXX := g++
.PHONY: build lint audit-rust inspect inventory milestones final inception test-harness
build:
\tcargo build --manifest-path dev/Cargo.toml --workspace --release --locked
lint:
\t{quality} --review
audit-rust:
\t{control}/venv/bin/python {control}/port_audit.py
inspect:
\t{port} inspect $(SOURCE)
inventory:
\t{port} inventory
milestones:
\t{port} milestones
final:
\t{port} final
inception:
\tpython3 {control}/clone_bootstrap.py --final
test-harness:
\t{control}/venv/bin/python -m unittest discover -s {control} -p 'test_*.py'
test-pa%:
\t{checkpoint} stage pa$*
course-pa%:
\t{checkpoint} course pa$*
'''
    (root / 'Makefile').write_text(makefile)
    check = lambda command, **kwargs: {'command': command, 'required': True, **kwargs}
    checks = {
        'preflight': check(port + ' preflight'),
        'sourceFiles': check(port + ' inventory', required=False, primary=True, kind='test', targetStage='pa33', dependsOn=['preflight']),
        'rustQuality': check(quality + ' --review', dependsOn=['preflight']),
        'sourceProgress': check('ralph:current-stage-progress sourceFiles {{testStage}}', dependsOn=['rustQuality']),
        'sourceProgressPreserved': check('ralph:current-stage-progress sourceFiles {{testStage}} mode=preserve', dependsOn=['rustQuality']),
        'sourceComplete': check(port + ' inventory', primary=True, kind='test', targetStage='pa33', onlyStages=['pa33'], dependsOn=['preflight']),
        'fullParity': check(port + ' final', onlyStages=['pa33'], dependsOn=['sourceComplete']),
        'bootstrapProgress': check(checkpoint + ' stage pa34', onlyStages=['pa34'], primary=True, kind='test', targetStage='pa34', dependsOn=['preflight']),
        'bootstrapRustQuality': check(quality, onlyStages=['pa34'], dependsOn=['preflight']),
        'bootstrapSourceReview': check(port + ' correspondence', onlyStages=['pa34'], dependsOn=['preflight']),
        'bootstrapProof': check('python3 ' + str(control / 'clone_bootstrap.py') + ' --final', onlyStages=['pa34'], dependsOn=['bootstrapProgress', 'bootstrapRustQuality', 'bootstrapSourceReview']),
    }
    config = json.loads((BASE_EXAMPLE / 'v5rust.config.json').read_text())
    config.update(baseDir=str(base), workdir=str(base / NAME), name=NAME,
                  initialStage='pa33', stopAfterStage='pa34', maxTurns=1000,
                  testCommand=port + ' inventory', checks=checks,
                  codexPath=str(control / ('codex-' + NAME)), stateBaseDir=str(base / '.ralph'))
    config['sessionIsolation']['privateWriteDir'] = str(private)
    config['phases'] = [
        {'name': 'implement', 'promptTemplate': 'implement', 'goalTemplate': 'implement-goal',
         'promptTemplates': {'pa34': 'pa34-implement'}, 'goalTemplates': {'pa34': 'pa34-implement-goal'},
         'checkpointOnRequiredChecks': True, 'checkpointPhase': 'checkpointAudit', 'checkpointPhaseEvery': 3,
         'checks': ['preflight', 'sourceFiles', 'bootstrapProgress', 'rustQuality', 'sourceProgress']},
        {'name': 'checkpointAudit', 'promptTemplate': 'checkpointAudit', 'goalTemplate': 'checkpointAudit-goal',
         'checkpointOnly': True, 'runWhenChecksPass': True, 'returnPhaseOnIncompletePrimary': 'implement',
         'checks': ['preflight', 'sourceFiles', 'bootstrapProgress', 'rustQuality', 'sourceProgressPreserved']},
        {'name': 'audit', 'promptTemplate': 'audit', 'goalTemplate': 'audit-goal',
         'promptTemplates': {'pa34': 'pa34-audit'}, 'goalTemplates': {'pa34': 'pa34-audit-goal'},
         'runWhenChecksPass': True,
         'checks': ['preflight', 'sourceComplete', 'fullParity', 'bootstrapProgress', 'bootstrapRustQuality', 'bootstrapSourceReview', 'bootstrapProof']},
    ]
    checks['sourceFiles']['excludeStages'] = ['pa34']
    # Stage-specific progress guards use the corresponding primary name.
    checks['sourceProgress']['excludeStages'] = ['pa34']
    checks['sourceProgressPreserved']['excludeStages'] = ['pa34']
    checks['bootstrapProgress']['required'] = False
    for name, mode in [('bootstrapAdvance', ''), ('bootstrapPreserved', ' mode=preserve')]:
        checks[name] = check('ralph:current-stage-progress bootstrapProgress {{testStage}}' + mode,
                             onlyStages=['pa34'], dependsOn=['rustQuality'])
    config['phases'][0]['checks'].append('bootstrapAdvance')
    config['phases'][1]['checks'].append('bootstrapPreserved')
    for directory in (base, HERE):
        module.json_file(directory / (NAME + '.config.json'), config)
    launcher = control / ('codex-' + NAME)
    launcher.write_text((control / 'codex-v5rust').read_text())
    launcher.chmod(0o755)
    (control / 'codex-v5rust').unlink()
    prompts(base, control)
    environment = dict(os.environ, CARGO_HOME=str(private / 'cache/cargo'), CARGO_TARGET_DIR=str(root / 'obj/rust'))
    subprocess.run(['cargo', 'generate-lockfile', '--manifest-path', str(root / 'dev/Cargo.toml')], env=environment, check=True)
    module.freeze(tracked)
    frozen = json.loads((control / 'manifest.json').read_text())
    for name in ('spec.md', 'porting.md', 'port/inventory.json', 'scripts/port_check.py'):
        frozen['protected'][name] = module.sha(root / name)
    for destination in (control / 'manifest.json', root / 'scripts/clone/manifest.json'):
        module.json_file(destination, frozen)
    (base / NAME).symlink_to(root, target_is_directory=True)
    subprocess.run(['git', 'init', '-q', '-b', 'main', str(root)], check=True)
    print(f'Created {NAME}: {len(source_inventory["sources"])} frozen source files; no translations or model sessions started.')


if __name__ == '__main__':
    main()
