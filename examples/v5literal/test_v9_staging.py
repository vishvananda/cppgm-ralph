"""A release migration stages controllers and Rust owners without changing V8."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from reference_update import census, sha

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('v9stage', REPO / 'scripts/prepare-v9literal.py')
v9stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v9stage)


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.PIPE).strip()


def init(root):
    root.mkdir(parents=True)
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'Fixture')
    git(root, 'config', 'user.email', 'fixture@example.invalid')


def commit(root):
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'fixture')
    return git(root, 'rev-parse', 'HEAD')


def write(root, name, data):
    p = root / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(data)


class V9StagingTests(unittest.TestCase):
    def test_stage_retains_implementation_relocates_driver_and_includes_c_without_active_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source, assignments, active, control = [base / n for n in ['source', 'assignments', 'active', 'control']]
            for p in [source, assignments, active]:
                init(p)
            write(source, 'dev/cppgm++.cpp', 'int main() { return 0; }\n')
            names = ['pptoken', 'posttoken', 'ppexpr', 'preproc', 'cppgm', 'abimangle', 'lowir', 'lowiropt', 'lowir2native']
            write(source, '.gitignore', '\n'.join('/dev/' + n for n in names) + '\n')
            old_revision = commit(source)
            old = census(source, old_revision)
            git(source, 'mv', 'dev/cppgm++.cpp', 'dev/cppgm.cpp')
            revision = commit(source)
            for name in names:
                write(source, 'dev/' + name, 'compiled oracle fixture')
            write(assignments, 'pa1/README.md', 'old course')
            old_assignments = commit(assignments)
            write(assignments, 'pa38/README.md', 'C language')
            write(assignments, 'pa38/tests/c.t', 'int f(void) { return 1; }')
            new_assignments = commit(assignments)
            control.mkdir()
            (control / 'venv').mkdir()
            settings = {'checkout': str(active), 'reference': str(source), 'revision': old_revision,
                        'assignment_revision': old_assignments, 'artifacts': str(base / 'old-artifacts'),
                        'state_dir': str(base / 'old-state')}
            write(control, 'settings.json', json.dumps(settings))
            write(control, 'source-inventory.json', json.dumps(old))
            write(control, 'bin/cppgm++', '#!/bin/sh\nexit 86\n')
            owner = old['sources']['dev/cppgm++.cpp']['rust_path']
            write(active, owner, 'pub fn main() {}\n')
            write(active, 'dev/src/translated/mod.rs', '#[path = "cppgm++_cpp.rs"] pub mod entry;\n')
            write(active, 'dev/Makefile', 'TOOLS = cppgm++\n')
            write(active, 'Makefile', 'EXPERIMENTAL_PAS ?= pa34 pa35\n')
            write(active, 'pa1/README.md', 'old course')
            write(active, 'AGENTS.md', 'PA34 bootstrap. PA1–PA33 checks.\n')
            write(active, 'spec.md', 'No PA35 optimization target.\n')
            write(active, 'port/inventory.json', json.dumps(old))
            write(active, 'port/reference-update.json', '{}')
            write(active, 'port/unsafe.json', '{"entries": []}')
            write(active, 'port/milestones.json', '{"stages": ["pa1"]}')
            write(active, 'port/source-map.tsv', 'cpp_source\trust_owner\tstatus\ndev/cppgm++.cpp\t' + owner + '\tcomplete\n')
            write(active, 'port/reviews/dev/cppgm++.cpp.json', '{}')
            helper = (REPO / 'examples/v5rust/baseline_files.py').read_text()
            write(active, 'scripts/clone/baseline_files.py', helper)
            protected = {name: sha(active / name) for name in ['Makefile', 'AGENTS.md', 'spec.md', 'scripts/clone/baseline_files.py']}
            frozen = {'protected': protected, 'stages': {'pa1': []}, 'workspace_lints': {}}
            write(control, 'manifest.json', json.dumps(frozen))
            write(active, 'scripts/clone/manifest.json', json.dumps(frozen))
            before = commit(active)
            git(active, 'remote', 'add', 'origin', 'git@github.com:fixture/literal.git')
            pins = {'source_revision': revision, 'assignments_revision': new_assignments, 'assignments_tag': 'v0.9.0'}
            release = SimpleNamespace(verify_release=lambda *_: pins)
            output = base / 'prepared'
            with patch.object(v9stage, 'load_release', return_value=release):
                v9stage.stage(control, source, assignments, output)
            self.assertEqual(git(active, 'rev-parse', 'HEAD'), before)
            self.assertEqual(git(active, 'status', '--porcelain'), '')
            self.assertEqual(json.loads((control / 'settings.json').read_text()), settings)
            root = output / 'checkout'
            self.assertEqual((root / 'dev/src/translated/cppgm_cpp.rs').read_text(), 'pub fn main() {}\n')
            self.assertNotIn('cppgm++_cpp.rs', (root / 'dev/src/translated/mod.rs').read_text())
            staged = json.loads((output / 'control/settings.json').read_text())
            self.assertIn('pa38', staged['course_layout']['correctness_stages'])
            self.assertEqual(staged['course_layout']['bootstrap_stage'], 'pa35')
            self.assertTrue((root / 'pa38/tests/c.t').exists())
            manifest = json.loads((output / 'control/manifest.json').read_text())
            for name, expected in manifest['protected'].items():
                self.assertEqual(sha(root / name), expected, name)
            self.assertIn('pa38', manifest['stages'])
            self.assertEqual((root / 'scripts/clone/manifest.json').read_bytes(), (output / 'control/manifest.json').read_bytes())
            self.assertIn('PA38 is mandatory', (root / 'AGENTS.md').read_text())
            for name in names:
                self.assertIn(str(source / 'dev' / name), (root / 'dev' / (name + '-ref')).read_text())
                self.assertNotIn('clone_adapter', (root / 'dev' / (name + '-ref')).read_text())
            self.assertFalse((output / 'state').exists())
            report = json.loads((root / 'port/reference-update.json').read_text())
            self.assertEqual(report['recover'], ['dev/cppgm.cpp'])
            self.assertEqual(git(root, 'remote', 'get-url', 'origin'), 'git@github.com:fixture/literal.git')


if __name__ == '__main__':
    unittest.main()
