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


if __name__ == '__main__':
    unittest.main()
