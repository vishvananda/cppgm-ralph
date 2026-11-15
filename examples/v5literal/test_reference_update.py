"""A reference update preserves implementation but invalidates changed source reviews."""
import unittest

from reference_update import classify, updated_rows, reference_owned


class ReferenceUpdateTests(unittest.TestCase):
    def test_only_unchanged_completed_sources_keep_completion(self):
        def spec(value):
            return {'sha256': value, 'rust_path': 'dev/src/translated/' + value + '.rs'}
        old = {'revision': 'old', 'sources': {'same': spec('a'), 'changed': spec('b'),
                                             'removed': spec('c'), 'pending': spec('d')}}
        new = {'revision': 'new', 'sources': {'same': spec('a'), 'changed': spec('x'),
                                             'added': spec('e'), 'pending': spec('d')}}
        new['sources']['changed']['rust_path'] = old['sources']['changed']['rust_path']
        rows = [{'cpp_source': name, 'rust_owner': value['rust_path'],
                 'status': 'pending' if name == 'pending' else 'complete'}
                for name, value in old['sources'].items()]
        report = classify(old, new, rows)
        self.assertEqual(report['preserve'], ['same'])
        self.assertEqual(report['recover'], ['changed'])
        self.assertEqual(report['removed'], ['removed'])
        self.assertEqual(report['added'], ['added'])
        result = {row['cpp_source']: row['status'] for row in updated_rows(rows, new, report)}
        self.assertEqual(result, {'same': 'complete', 'changed': 'pending',
                                  'added': 'pending', 'pending': 'pending'})

    def test_reference_sync_cannot_replace_rust_or_literal_control_files(self):
        for path in ('dev/src/translated/foo.rs', 'dev/Cargo.toml', 'Makefile',
                     'port/reviews/dev/a.cpp.json', 'scripts/clone/port_check.py',
                     'scripts/clone_check.py', 'scripts/port_check.py'):
            self.assertFalse(reference_owned(path), path)
        for path in ('pa1/tests/a.t', 'pa34/Makefile', 'scripts/check_controls.pl',
                     'shared/source.gram', 'dev/frontend_source_sets.mk'):
            self.assertTrue(reference_owned(path), path)

    def test_second_release_preserves_unfinished_recovery_and_its_original_diff(self):
        old = {'revision': 'middle', 'sources': {
            name: {'sha256': value, 'rust_path': name + '.rs'}
            for name, value in [('unfinished', 'a'), ('recovered', 'b'), ('changed', 'c')]}}
        new = {'revision': 'latest', 'sources': {name: dict(spec) for name, spec in old['sources'].items()}}
        new['sources']['changed']['sha256'] = 'd'
        rows = [{'cpp_source': name, 'rust_owner': name + '.rs',
                 'status': 'pending' if name == 'unfinished' else 'complete'}
                for name in old['sources']]
        prior = {'old_revision': 'original', 'recover': ['unfinished', 'recovered', 'removed']}
        report = classify(old, new, rows, prior)
        self.assertEqual(report['recover'], ['changed', 'unfinished'])
        self.assertEqual(report['previous_pending_recovery'], ['unfinished'])
        self.assertEqual(report['recovery_baselines'], {'changed': 'middle', 'unfinished': 'original'})
        again = classify(new, new, rows, report)
        self.assertEqual(again['recovery_baselines']['unfinished'], 'original')


class RenameRecoveryTests(unittest.TestCase):
    def test_driver_rename_retains_recovery_origin_but_not_stale_completion(self):
        old = {'revision': 'old', 'sources': {'dev/cppgm++.cpp': {'sha256': 'a', 'rust_path': 'old.rs'}}}
        new = {'revision': 'new', 'sources': {'dev/cppgm.cpp': {'sha256': 'b', 'rust_path': 'new.rs'}}}
        rows = [{'cpp_source': 'dev/cppgm++.cpp', 'rust_owner': 'old.rs', 'status': 'complete'}]
        report = classify(old, new, rows, renames={'dev/cppgm++.cpp': 'dev/cppgm.cpp'})
        self.assertEqual(report['recover'], ['dev/cppgm.cpp'])
        self.assertEqual(report['recovery_origins'], {'dev/cppgm.cpp': 'dev/cppgm++.cpp'})
        self.assertEqual(report['rust_relocations'], {'old.rs': 'new.rs'})
        self.assertEqual(report['preserve'], [])
        self.assertEqual(updated_rows(rows, new, report)[0]['status'], 'pending')

    def test_invalid_or_ambiguous_rename_map_is_rejected(self):
        old = {'revision': 'old', 'sources': {'old': {'sha256': 'a', 'rust_path': 'a.rs'}}}
        new = {'revision': 'new', 'sources': {'new': {'sha256': 'b', 'rust_path': 'b.rs'}}}
        with self.assertRaises(ValueError):
            classify(old, new, [], renames={'missing': 'new'})

    def test_rename_carries_unfinished_recovery_back_to_its_original_source(self):
        old = {'revision': 'middle', 'sources': {'old.cpp': {'sha256': 'a', 'rust_path': 'a.rs'}}}
        new = {'revision': 'new', 'sources': {'new.cpp': {'sha256': 'b', 'rust_path': 'b.rs'}}}
        rows = [{'cpp_source': 'old.cpp', 'rust_owner': 'a.rs', 'status': 'pending'}]
        previous = {'old_revision': 'original', 'recover': ['old.cpp']}
        report = classify(old, new, rows, previous, renames={'old.cpp': 'new.cpp'})
        self.assertEqual(report['recovery_baselines'], {'new.cpp': 'original'})
        self.assertEqual(report['recovery_origins'], {'new.cpp': 'old.cpp'})
        again = classify(new, new, updated_rows(rows, new, report), report)
        self.assertEqual(again['recovery_baselines'], {'new.cpp': 'original'})
        self.assertEqual(again['recovery_origins'], {'new.cpp': 'old.cpp'})


if __name__ == '__main__':
    unittest.main()
