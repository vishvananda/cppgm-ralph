"""Literal progress needs real current source correspondence and evidence."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import clone_common as common
import clone_quality
import port_audit
import port_check
from port_inventory import digest, freeze_source, rust_path, rust_syntax


class InventoryTests(unittest.TestCase):
    def test_header_and_implementation_paths_stay_distinct(self):
        self.assertEqual(rust_path('dev/src/sema/analyzer.h'), 'dev/src/translated/src/sema/analyzer_h.rs')
        self.assertEqual(rust_path('dev/src/sema/analyzer.cpp'), 'dev/src/translated/src/sema/analyzer_cpp.rs')

    def test_cpp_functions_include_overloads_and_inline_bodies(self):
        source = b'int f(int x) { return x; }\nint f() { return 1; }\nstruct X { int g() { return 2; } };'
        spec = freeze_source('dev/a.cpp', source)
        self.assertEqual(len(spec['functions']), 3)
        self.assertEqual(len({f['id'] for f in spec['functions']}), 3)
        self.assertEqual(spec, freeze_source('dev/a.cpp', source))

    def test_test_only_rust_functions_and_comments_do_not_count(self):
        data = b'pub fn f() {}\n#[cfg(test)] mod tests { fn helper() {} }\n'
        self.assertEqual([f['name'] for f in rust_syntax(data)['functions']], ['f'])
        self.assertEqual(rust_syntax(b'// pub fn f() {}')['declarations'], [])
        self.assertEqual(len(rust_syntax(b'#[cfg(not(test))] pub fn f() {}')['functions']), 1)

    def test_unsafe_functions_blocks_and_externs_are_reviewable(self):
        data = b'pub unsafe fn f(p: *const u8) -> u8 { unsafe { *p } }\nunsafe extern "C" { fn host(); }'
        self.assertEqual(len(rust_syntax(data)['unsafe']), 3)

    def test_identical_methods_in_different_classes_have_distinct_identities(self):
        data = b'struct A; struct B; impl A { fn value() -> u8 { 1 } } impl B { fn value() -> u8 { 1 } }'
        functions = rust_syntax(data)['functions']
        self.assertEqual(len({f['sha256'] for f in functions}), 2)
        data = b'unsafe fn a() {} unsafe fn b() {}'
        self.assertEqual(len({f['sha256'] for f in rust_syntax(data)['unsafe']}), 2)


class CorrespondenceTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(common, 'ROOT', self.root))
        self.source = 'dev/a.cpp'
        self.spec = freeze_source(self.source, b'int f(int x) { return x + 1; }')
        self.file = self.root / self.spec['rust_path']; self.file.parent.mkdir(parents=True)
        self.file.write_text('pub fn f(x: i32) -> i32 { x + 1 }\n')
        self.log = self.root / 'validation.log'; self.log.write_text('successful actual command\n')
        self.receipt = self.root / 'receipt.json'
        self.value = {'exit': 0, 'source_files': {self.spec['rust_path']: digest(self.file.read_bytes())},
                      'log': str(self.log), 'log_sha256': common.file_digest(self.log)}
        self.receipt.write_text(json.dumps(self.value))
        function = rust_syntax(self.file.read_bytes())['functions'][0]
        self.review = {'source_sha256': self.spec['sha256'], 'rust_sha256': digest(self.file.read_bytes()),
                       'declarations_reviewed': True, 'state_lifetimes_reviewed': True,
                       'functions': {self.spec['functions'][0]['id']: {'rust_sha256': function['sha256']}},
                       'manual_ranges': [], 'adaptations': [],
                       'validation': [{'path': str(self.receipt), 'sha256': common.file_digest(self.receipt)}]}
        self.review_path = self.root / 'port/reviews/dev/a.cpp.json'
        self.review_path.parent.mkdir(parents=True)
        self.save()

    def save(self):
        self.review_path.write_text(json.dumps(self.review))

    def check(self):
        return port_check.review_complete(self.source, self.spec, {self.file.resolve()})[0]

    def test_complete_current_correspondence_is_accepted(self):
        self.assertTrue(self.check())

    def test_generated_review_draft_cannot_certify_source(self):
        with patch.object(port_check, 'inventory', return_value={self.source: self.spec}):
            self.review = port_check.draft(self.source)
        self.save()
        self.assertFalse(self.review['declarations_reviewed'])
        self.assertFalse(self.review['state_lifetimes_reviewed'])
        self.assertEqual(self.review['validation'], [])
        self.assertFalse(self.check())

    def test_source_edit_invalidates_the_review(self):
        self.file.write_text('pub fn f(x: i32) -> i32 { x + 2 }\n')
        self.assertFalse(self.check())

    def test_missing_original_function_or_uncompiled_module_cannot_pass(self):
        self.review['functions'] = {}; self.save()
        self.assertFalse(self.check())
        self.assertFalse(port_check.review_complete(self.source, self.spec, set())[0])

    def test_old_dep_info_does_not_certify_an_unregistered_file(self):
        release = self.root / 'obj/rust/release'; (release / 'deps').mkdir(parents=True)
        (release / 'deps/cppgm_rust-old.d').write_text('old: ' + str(self.file))
        self.assertNotIn(self.file.resolve(), port_check.production_files())
        (release / 'libcppgm_rust.d').write_text('current: ' + str(self.file))
        self.assertIn(self.file.resolve(), port_check.production_files())

    def test_evidence_tampering_or_failed_validation_cannot_pass(self):
        self.log.write_text('modified log')
        self.assertFalse(self.check())
        self.value['exit'] = 1; self.value['log_sha256'] = common.file_digest(self.log)
        self.receipt.write_text(json.dumps(self.value))
        self.review['validation'][0]['sha256'] = common.file_digest(self.receipt); self.save()
        self.assertFalse(self.check())

    def test_recorded_command_binds_current_sources_and_actual_failure(self):
        self.stack.enter_context(patch.object(common, 'ARTIFACTS', self.root / 'artifacts'))
        self.stack.enter_context(patch.object(port_check, 'inventory', return_value={self.source: self.spec}))
        self.stack.enter_context(patch.object(common, 'run', return_value=(1, b'failed', b'')))
        with contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())):
            self.assertEqual(port_check.record(['false']), 1)
        receipt = json.loads(next((self.root / 'artifacts').rglob('receipt.json')).read_text())
        self.assertEqual(receipt['exit'], 1)
        self.assertEqual(receipt['source_files'][self.spec['rust_path']], digest(self.file.read_bytes()))


class UnsafeAndFinalTests(unittest.TestCase):
    def test_legacy_release_uses_the_configured_literal_source_map(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'port').mkdir(); (root / 'dev').mkdir()
            (root / 'dev/a.rs').write_text('pub fn a() {}')
            (root / 'port/source-map.tsv').write_text('cpp_source\trust_owner\tstatus\ndev/a.cpp\tdev/a.rs\tcomplete\n')
            with patch.object(port_check.clone_check, 'ROOT', root), \
                    patch.dict(port_check.clone_check.SETTINGS, {'source_map_path': 'port/source-map.tsv'}), \
                    patch.object(port_check.clone_check, 'manifest', return_value={'source_responsibilities': ['dev/a.cpp']}):
                self.assertTrue(port_check.clone_check.ownership_complete())

    def test_unsafe_needs_exact_current_review(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'dev/src/compat').mkdir(parents=True); (root / 'port').mkdir()
            (root / 'port/inventory.json').write_text(json.dumps({'sources': {}}))
            file = root / 'dev/src/compat/raw.rs'
            file.write_text('pub unsafe fn load(p: *const u8) -> u8 { unsafe { *p } }')
            ledger = root / 'port/unsafe.json'; ledger.write_text(json.dumps({'entries': []}))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(port_audit.audit(root))
            entries = []
            for item in rust_syntax(file.read_bytes())['unsafe']:
                entries.append({'file': str(file.relative_to(root)), 'sha256': item['sha256'],
                                'source': 'compat: raw arena operation', 'reason': 'Preserve original stable pointer identities',
                                'invariants': 'Caller retains allocation lifetime and validity',
                                'validation': 'Pointer lifetime controls are recorded separately'})
            ledger.write_text(json.dumps({'entries': entries}))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(port_audit.audit(root))
            file.write_text(file.read_text().replace('*p', '*p.add(1)'))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(port_audit.audit(root))

    def test_final_requires_every_stage_and_all_debug_lanes(self):
        with patch.object(port_check, 'progress', return_value=True), \
                patch.object(clone_quality, 'checks', return_value=0), \
                patch.object(port_check.clone_check, 'completed_stages', return_value=0) as stages, \
                patch.object(port_check.clone_check, 'course', return_value=True) as debug:
            self.assertTrue(port_check.final())
            stages.assert_called_once_with(33)
            self.assertEqual([call.args for call in debug.call_args_list],
                             [('pa8', 'test-debuginfo'), ('pa32', 'test-debuginfo'), ('pa33', 'test-debuginfo')])


if __name__ == '__main__':
    unittest.main()
