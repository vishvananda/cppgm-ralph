"""Bootstrap probes are bounded diagnostics, never acceptance or oracle fallback."""
import contextlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import clone_bootstrap_probe as probe


class BootstrapProbeTests(unittest.TestCase):
    def test_same_paths_clean_candidate_outputs_and_preserved_reference_evidence(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            root = Path(directory)
            work = root / 'work'; (work / 'pa34').mkdir(parents=True)
            reference = root / 'reference'; (reference / 'dev/src').mkdir(parents=True)
            source = reference / 'dev/src/a.cpp'; source.write_text('int a;')
            control = root / 'control'; control.mkdir()
            (control / 'manifest.json').write_text(json.dumps({'oracle_sources': {
                'dev/src/a.cpp': probe.file_digest(source)}}))
            stack.enter_context(patch.object(probe.bootstrap, 'WORK', work))
            stack.enter_context(patch.object(probe, 'REFERENCE', reference))
            stack.enter_context(patch.object(probe, 'CONTROL', control))
            stack.enter_context(patch.object(probe, 'candidate_path', return_value=root / 'candidate'))
            commands = []
            obj = work / 'obj/pa34/parity-probe/shared/release/a.o'

            def run(command, **_):
                commands.append(command)
                self.assertFalse(obj.exists(), 'candidate must never inherit the oracle object')
                obj.parent.mkdir(parents=True, exist_ok=True)
                if len(commands) == 1:
                    obj.write_bytes(b'oracle-object')
                    return 0, b'PROBE object: ../obj/pa34/parity-probe/shared/release/a.o\n', b''
                return 1, b'PROBE object: ../obj/pa34/parity-probe/shared/release/a.o\n', b'compile error'

            stack.enter_context(patch.object(probe, 'run', side_effect=run))
            result = probe.compare_source('dev/src/a.cpp', root / 'evidence')
            self.assertEqual(result['status'], 'mismatch')
            self.assertIsNone(result['candidate']['object_sha256'])
            self.assertEqual((root / 'evidence/reference.o').read_bytes(), b'oracle-object')
            for command in commands:
                self.assertIn('SOURCE=../dev/src/a.cpp', command)
                self.assertIn('INCEPTION_SELFHOST_OPT_LEVEL=3', command)
                self.assertIn('PROBE_OBJ_ROOT=../obj/pa34/parity-probe', command)

    def test_stops_at_first_mismatch_and_does_not_claim_acceptance(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            root = Path(directory)
            stack.enter_context(patch.object(probe, 'ARTIFACTS', root))
            stack.enter_context(patch.object(probe, 'prepare'))
            stack.enter_context(patch.object(probe, 'sources', return_value=['a', 'b', 'c']))
            stack.enter_context(patch.object(probe, 'file_digest', return_value='sha'))
            compare = stack.enter_context(patch.object(probe, 'compare_source', side_effect=[
                {'source': 'a', 'status': 'match'}, {'source': 'b', 'status': 'mismatch'}]))
            self.assertEqual(probe.diagnose(limit=3), 1)
            self.assertEqual(compare.call_count, 2)
            report = json.loads(next(root.rglob('report.json')).read_text())
            self.assertFalse(report['acceptance_claim'])
            self.assertTrue(report['final_acceptance_required'])
            self.assertEqual(len(report['results']), 2)

    def test_frozen_make_inventory_and_requested_bounds(self):
        output = b'shared ../dev/src/sema/analyzer.cpp\nshared ../dev/src/testing/test_runner.cpp\nentry cppgm++\n'
        with patch.object(probe, 'run', return_value=(0, output, b'')):
            self.assertEqual(probe.sources(), ['dev/src/sema/analyzer.cpp',
                'dev/src/testing/test_runner.cpp', 'dev/cppgm++.cpp'])
        with self.assertRaises(ValueError):
            probe.diagnose(limit=0)
        with self.assertRaises(ValueError):
            probe.compare_source("dev/src/a.cpp'; false; '", Path('/unused'))


if __name__ == '__main__':
    unittest.main()
