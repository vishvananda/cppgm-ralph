"""Release provenance and unstarted-scaffold migration, using real tiny Git repos."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


release = module('release_inputs', 'scripts/release-inputs.py')
migration = module('prepare_v9sol', 'scripts/prepare-v9sol.py')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.PIPE).strip()


def init(root):
    root.mkdir(parents=True)
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'Fixture')
    git(root, 'config', 'user.email', 'fixture@example.invalid')


def commit(root, message):
    git(root, 'add', '.')
    git(root, 'commit', '-qm', message)
    return git(root, 'rev-parse', 'HEAD')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.source = self.base / 'source'
        init(self.source)
        (self.source / 'marker').write_text('release')
        self.sha = commit(self.source, 'source')
        git(self.source, 'tag', '-a', 'v0.9.0', '-m', 'version')
        git(self.source, 'tag', 'assignments-v9')
        self.assignments = self.base / 'assignments'
        init(self.assignments)
        (self.assignments / 'reference-binaries').mkdir()
        self.manifest = self.assignments / 'reference-binaries/manifest.tsv'
        self.manifest.write_text(f'source_sha\t{self.sha}\nbinary\tcppgm\tfixture-hash\n')
        for n in [29, 33, 34, 35, 36, 37, 38]:
            (self.assignments / f'pa{n}').mkdir()
            (self.assignments / f'pa{n}/README.md').write_text(f'PA{n}')
        self.assignment_sha = commit(self.assignments, 'export')
        git(self.assignments, 'tag', 'v0.9.0')

    def verify(self):
        return release.verify_release(self.source, self.assignments, expected=self.sha)

    def test_exact_tags_and_export_provenance(self):
        pins = self.verify()
        self.assertEqual(pins['source_revision'], self.sha)
        self.assertEqual(pins['assignments_revision'], self.assignment_sha)
        self.assertEqual(pins['optional_course_stages'], ['pa38'])
        # Working tree text cannot change the immutable tagged manifest.
        self.manifest.write_text('source_sha\twrong\n')
        self.assertEqual(self.verify()['source_revision'], self.sha)

    def test_rejects_missing_tags_or_mismatched_export(self):
        git(self.source, 'tag', '-d', 'assignments-v9')
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        git(self.source, 'tag', 'assignments-v9')
        self.manifest.write_text('source_sha\twrong\nbinary\tcppgm\thash\n')
        commit(self.assignments, 'wrong export')
        git(self.assignments, 'tag', '-f', 'v0.9.0')
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.verify()

    def test_rejects_unrenamed_driver_in_release(self):
        self.manifest.write_text(f'source_sha\t{self.sha}\nbinary\tcppgm++\thash\n')
        commit(self.assignments, 'old driver')
        git(self.assignments, 'tag', '-f', 'v0.9.0')
        with self.assertRaisesRegex(ValueError, 'renamed'):
            self.verify()

    def test_preparation_preserves_old_work_and_only_adds_new_spec(self):
        work = self.base / 'work'
        root = work / 'private/v8sol/checkout'
        init(root)
        (root / 'marker').write_text('old scaffold')
        base = commit(root, 'old base')
        (root / 'spec.md').write_text('old spec')
        old_tip = commit(root, 'old preparation')
        git(root, 'remote', 'add', 'origin', 'git@github.com:vishvananda/cppgm-run-v8sol.git')
        (work / 'v8sol').symlink_to(root)
        config = json.loads((ROOT / 'examples/v8sol/v8sol.config.json').read_text())
        config.update(baseDir=str(work), workdir=str(work / 'v8sol'), stateBaseDir=str(work / '.ralph'))
        config['sessionIsolation']['privateWriteDir'] = str(root.parent)
        (work / 'v8sol.config.json').write_text(json.dumps(config))
        # Create the assignment release as a descendant of the original base.
        git(self.assignments, 'fetch', str(root), base)
        git(self.assignments, 'merge', '--allow-unrelated-histories', '-s', 'ours', '--no-edit', base)
        # Merge ancestry is enough; erase the old marker in the exported tree.
        commit_sha = git(self.assignments, 'rev-parse', 'HEAD')
        git(self.assignments, 'tag', '-f', 'v0.9.0', commit_sha)
        original_base, original_verify = migration.OLD_BASE, migration.release.verify_release
        migration.OLD_BASE = base
        migration.release.verify_release = lambda source, assignments: release.verify_release(source, assignments, expected=self.sha)
        try:
            report = migration.plan(work, self.source, self.assignments)
            output = self.base / 'prepared'
            candidate = migration.prepare(report, output)
            self.assertEqual(git(root, 'rev-parse', 'HEAD'), old_tip)
            self.assertEqual((root / 'spec.md').read_text(), 'old spec')
            self.assertFalse((work / 'v9sol').exists())
            self.assertEqual(git(candidate, 'diff', '--name-only', commit_sha, 'HEAD'), 'spec.md')
            self.assertEqual(report['config']['stopAfterStage'], 'pa37')
            self.assertEqual(report['config']['sourceRelease']['assignmentsRevision'], commit_sha)
            self.assertFalse((work / '.ralph').exists())
            (root / 'implementation.cpp').write_text('student work')
            with self.assertRaisesRegex(ValueError, 'clean'):
                migration.plan(work, self.source, self.assignments)
        finally:
            migration.OLD_BASE, migration.release.verify_release = original_base, original_verify


class CloneRoutingTests(unittest.TestCase):
    def test_v9_profile_routes_all_required_port_stages_including_c(self):
        with tempfile.TemporaryDirectory() as temporary:
            control = Path(temporary)
            for name in ['clone_common.py', 'clone_check.py', 'clone_bootstrap.py', 'clone_adapter.py']:
                (control / name).write_bytes((ROOT / 'examples/v5rust' / name).read_bytes())
            stages = [*[f'pa{n}' for n in range(1, 35)], 'pa37', 'pa38']
            (control / 'settings.json').write_text(json.dumps({'checkout': str(control / 'checkout'),
                'reference': str(control / 'reference'), 'artifacts': str(control / 'artifacts'),
                'course_layout': {'id': 'v9', 'driver_tool': 'cppgm', 'bootstrap_stage': 'pa35',
                    'correctness_stages': stages, 'debug_stages': ['pa8', 'pa33', 'pa34']}}))
            code = '''
import clone_common as c,clone_check as check,clone_bootstrap as boot,clone_adapter as adapter
assert 'cppgm' in c.TOOLS and 'cppgm++' not in c.TOOLS
assert c.primary_tool(33)=='lowiropt'
assert c.primary_tool(34)=='lowir2native'
assert c.primary_tool(38)=='cppgm'
assert 38 in c.correctness_numbers() and 35 not in c.correctness_numbers() and 36 not in c.correctness_numbers()
assert 'CPPGM_TEST_APP='+str(c.CONTROL/'bin/cppgm') in check.routes('pa38')
assert 'CPPGM_TEST_APP='+str(c.CONTROL/'bin/lowiropt') in check.routes('pa33')
assert 'CPPGM_TEST_APP='+str(c.CONTROL/'bin/lowir2native') in check.routes('pa34')
assert str(boot.WORK/'pa35') in boot.recipe('compiler')
assert 'INCEPTION_OBJ_ROOT_BASE=../obj/pa35' in boot.recipe('compiler')
assert str(boot.BINS/'cppgm-self') in ' '.join(boot.rebuilt_bindings(38))
assert boot.OBJECTS==boot.WORK/'obj/pa35/selfhost'
'''
            subprocess.run(['python3', '-c', code], cwd=control, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
