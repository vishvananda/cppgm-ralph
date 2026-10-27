"""Evidence reuse cannot hide changed inputs, failures or damaged raw receipts."""
import contextlib
import io
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import clone_common
import clone_evidence as evidence
import clone_check
import clone_quality


class EvidenceTests(unittest.TestCase):
    def test_validation_path_is_pinned_without_changing_other_environment(self):
        with patch.dict(clone_common.SETTINGS, {'validation_path':'/configured/tools'}), \
                patch.dict('os.environ', {'PATH':'/temporary/agent/tools'}):
            self.assertEqual(clone_common.clean_env()['PATH'],'/configured/tools')
            self.assertEqual(clone_common.clean_env()['CPPGM_LOWIR_DIRECT_TEXT_COMPARE'],'1')

    def test_diagnostic_format_is_the_same_in_worker_and_runner(self):
        with patch.dict('os.environ', {'NO_COLOR':'1'}):
            worker=clone_common.clean_env()['NO_COLOR']
        with patch.dict('os.environ', {}, clear=True):
            runner=clone_common.clean_env()['NO_COLOR']
        self.assertEqual(worker,runner)
        self.assertEqual(worker,'1')

    def run_cache(self, root, state, action, paths=(), fresh=False):
        with patch.object(clone_common, 'ARTIFACTS', root), \
                patch.object(evidence, 'inputs', side_effect=lambda context: {'context': context, **state}), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return evidence.cached_gate('prior-pa29', action, lambda: paths, fresh=fresh)

    def test_success_reuses_unchanged_log_and_raw_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / 'raw.jsonl';raw.write_text('exact results')
            calls = []
            def action():
                calls.append(1);print('raw outcome');return 0
            for _ in range(2):
                self.assertEqual(self.run_cache(root, {'compiler': 'a'}, action, [raw]), 0)
            self.assertEqual(len(calls), 1)
            receipt=json.loads((root/'validation/prior-pa29/receipt.json').read_text())
            self.assertIn(str(raw), receipt['evidence'])

    def test_every_key_component_invalidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);calls=[]
            def action():calls.append(1);return 0
            state={'binary':'a','source':'a','fixture':'a','checker':'a','toolchain':'a','environment':'a'}
            self.run_cache(root,state,action)
            for key in list(state):
                state[key]='b';self.run_cache(root,state,action)
            self.assertEqual(len(calls),7)

    def test_changed_or_missing_raw_receipts_rerun(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);raw=root/'raw';calls=[]
            def action():calls.append(1);raw.write_text('valid');return 0
            self.run_cache(root,{},action,[raw])
            raw.write_text('changed');self.run_cache(root,{},action,[raw])
            raw.unlink();self.run_cache(root,{},action,[raw])
            self.assertEqual(len(calls),3)

    def test_failures_never_reuse_success_and_are_not_cached(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);calls=[]
            def fail():calls.append(1);print('failure');return 1
            self.run_cache(root,{},lambda:0)
            self.assertEqual(self.run_cache(root,{},fail,fresh=True),1)
            self.assertEqual(self.run_cache(root,{},fail),1)
            self.assertEqual(len(calls),2)
            self.assertFalse((root/'validation/prior-pa29/receipt.json').exists())
            self.assertEqual(len(list((root/'validation/prior-pa29').glob('*.log'))),3)

    def test_fresh_forces_new_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);calls=[]
            def action():calls.append(1);return 0
            self.run_cache(root,{},action)
            self.run_cache(root,{},action,fresh=True)
            self.assertEqual(len(calls),2)

    def test_exception_during_fresh_attempt_invalidates_old_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            self.run_cache(root,{},lambda:0)
            def fail():raise RuntimeError('infrastructure')
            with self.assertRaisesRegex(RuntimeError,'infrastructure'):
                self.run_cache(root,{},fail,fresh=True)
            self.assertFalse((root/'validation/prior-pa29/receipt.json').exists())

    def test_inputs_changed_during_check_are_not_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);state={'binary':'a'}
            def action():state['binary']='b';return 0
            with self.assertRaisesRegex(RuntimeError,'inputs changed'):
                self.run_cache(root,state,action)
            self.assertFalse((root/'validation/prior-pa29/receipt.json').exists())

    def test_tree_identity_detects_new_sources_contents_and_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'a.rs';source.write_text('first')
            a=evidence.tree_identity([root]);source.write_text('second')
            b=evidence.tree_identity([root]);self.assertNotEqual(a,b)
            new=root/'new.rs';new.write_text('new');c=evidence.tree_identity([root]);self.assertNotEqual(b,c)
            link=root/'link';link.symlink_to('a.rs');d=evidence.tree_identity([root]);self.assertNotEqual(c,d)
            link.unlink();link.symlink_to('new.rs');self.assertNotEqual(d,evidence.tree_identity([root]))
            before=evidence.tree_identity([root]);(root/'obj').mkdir();(root/'obj/cache').write_text('output')
            self.assertEqual(before,evidence.tree_identity([root]))

    def test_snapshot_rejects_stale_stage_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'results').mkdir();(root/'compiler').write_text('new')
            (root/'results/pa29.json').write_text(json.dumps({'binaries':{'cppgm++':'old'}}))
            with patch.object(clone_common,'ARTIFACTS',root),patch.object(clone_common,'TOOLS',['cppgm++']), \
                    patch.object(clone_common,'candidate_path',return_value=root/'compiler'):
                with self.assertRaisesRegex(ValueError,'stale'):
                    evidence.snapshot('pa29',root/'snapshot.json')

    def test_actual_input_inventory_changes_for_source_fixture_and_control(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'repo';root.mkdir()
            subprocess.run(['git','init','-q',str(root)],check=True)
            control=Path(directory)/'control';control.mkdir()
            source=root/'dev/src/a.rs';source.parent.mkdir(parents=True);source.write_text('one')
            fixture=root/'pa1/tests/a.t';fixture.parent.mkdir(parents=True);fixture.write_text('one')
            script=control/'clone_check.py';script.write_text('one')
            binary=root/'compiler';binary.write_text('one')
            with patch.object(clone_common,'ROOT',root),patch.object(clone_common,'CONTROL',control), \
                    patch.object(clone_common,'TOOLS',['cppgm++']), \
                    patch.object(clone_common,'candidate_path',return_value=binary), \
                    patch.object(evidence,'host_identity',return_value={'host':'fixed'}):
                keys=[common_key('prior-pa2')]
                for path in (source,fixture,script,binary):
                    path.write_text('two');keys.append(common_key('prior-pa2'))
                self.assertEqual(len(set(keys)),5)
                (root/'docs/port').mkdir(parents=True)
                (root/'docs/port/pa1.md').write_text('journal update')
                self.assertEqual(keys[-1],common_key('prior-pa2'))
                (root/'.gitignore').write_text('*.t\n*.ref\n')
                ignored=fixture.parent/'ignored.t';ignored.write_text('first')
                a=common_key('prior-pa2');ignored.write_text('second')
                self.assertNotEqual(a,common_key('prior-pa2'))
                sidecar=fixture.parent/'ignored.ref';sidecar.write_text('first')
                a=common_key('prior-pa2');sidecar.write_text('second')
                self.assertNotEqual(a,common_key('prior-pa2'))

    def test_prior_builds_and_preflights_before_success_reuse(self):
        with patch.object(clone_check,'build') as build,patch.object(clone_check,'preflight') as preflight, \
                patch.object(evidence,'cached_gate',return_value=0) as reuse, \
                patch.object(sys,'argv',['clone_check.py','prior','pa29','--fresh']):
            self.assertEqual(clone_check.main(),0)
            build.assert_called_once();preflight.assert_called_once()
            self.assertEqual(reuse.call_args.args[0],'prior-pa29')
            self.assertTrue(reuse.call_args.kwargs['fresh'])

    def test_current_stage_and_through_never_reuse_gate_success(self):
        for mode in ('stage','through'):
            with patch.object(clone_check,'build'),patch.object(clone_check,'preflight'), \
                    patch.object(clone_check,'stage_check',return_value=True), \
                    patch.object(clone_check,'completed_stages',return_value=0), \
                    patch.object(evidence,'cached_gate') as reuse, \
                    patch.object(sys,'argv',['clone_check.py',mode,'pa29']):
                self.assertEqual(clone_check.main(),0);reuse.assert_not_called()

    def test_quality_fresh_and_checks_are_preserved(self):
        with patch.object(evidence,'cached_gate',return_value=1) as reuse, \
                patch.object(sys,'argv',['clone_quality.py','--fresh']):
            self.assertEqual(clone_quality.main(),1)
            self.assertIs(reuse.call_args.args[1],clone_quality.checks)
            self.assertTrue(reuse.call_args.kwargs['fresh'])


class AuditCheckpointTests(unittest.TestCase):
    @contextlib.contextmanager
    def workspace(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            root = Path(directory)
            (root/'manifest.json').write_text('{}')
            binary = root/'compiler';binary.write_bytes(b'compiler')
            binaries = {'cppgm++': clone_common.file_digest(binary)}
            stack.enter_context(patch.object(clone_common, 'ARTIFACTS', root))
            stack.enter_context(patch.object(clone_common, 'CONTROL', root))
            stack.enter_context(patch.object(clone_common, 'TOOLS', ('cppgm++',)))
            stack.enter_context(patch.object(clone_common, 'candidate_path', return_value=binary))
            stack.enter_context(patch.object(evidence, 'inputs', side_effect=lambda context:
                {'context': context, 'source': 'current', 'binaries': binaries}))
            stack.enter_context(patch.object(clone_check, 'stage_cases', return_value=['tests/a.t']))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield root, binaries

    def report(self, root, binaries):
        path = root/'results/pa33.json';path.parent.mkdir(exist_ok=True)
        clone_common.write_json(path, {
            'binaries': binaries,
            'manifest_sha256': clone_common.file_digest(root/'manifest.json'),
            'results': [{'case':'tests/a.t','passed':True}],
        })

    def test_open_audit_indexes_focused_evidence_without_running_acceptance(self):
        with self.workspace() as (root, _), patch.object(evidence, 'cached_gate') as gate:
            raw = root/'focused.jsonl';raw.write_text('{"match":true}')
            output = root/'checkpoint.json'
            evidence.checkpoint('pa33', output, [raw])
            value = json.loads(output.read_text())
            self.assertFalse(value['acceptance_claim'])
            self.assertTrue(value['final_acceptance_required'])
            self.assertFalse(value['prior']['reused_success'])
            self.assertFalse(value['quality']['reused_success'])
            self.assertFalse(value['stage_report']['current'])
            self.assertEqual(value['focused_evidence'][str(raw)], clone_common.file_digest(raw))
            self.assertFalse((root/'validation').exists())
            gate.assert_not_called()

    def test_checkpoint_preserves_stale_receipts_and_detects_damaged_evidence(self):
        with self.workspace() as (root, _):
            raw = root/'raw.log';raw.write_text('original')
            directory = root/'validation/quality';directory.mkdir(parents=True)
            receipt = directory/'receipt.json'
            saved = {'version':evidence.VERSION,
                'identity':common_key('quality'), 'exit':0,
                'evidence':{str(raw):clone_common.file_digest(raw)}}
            clone_common.write_json(receipt, saved)
            original = receipt.read_bytes()
            output = root/'checkpoint.json'
            evidence.checkpoint('pa33', output)
            self.assertTrue(json.loads(output.read_text())['quality']['reused_success'])
            raw.write_text('changed')
            evidence.checkpoint('pa33', output)
            self.assertFalse(json.loads(output.read_text())['quality']['reused_success'])
            self.assertEqual(receipt.read_bytes(), original)

    def test_current_and_stale_stage_reports_never_establish_acceptance(self):
        with self.workspace() as (root, binaries):
            self.report(root, binaries)
            output = root/'checkpoint.json'
            evidence.checkpoint('pa33', output)
            value = json.loads(output.read_text())
            self.assertTrue(value['stage_report']['current'])
            self.assertFalse(value['acceptance_claim'])
            with patch.object(clone_check, 'stage_cases', return_value=['tests/a.t','tests/new.t']):
                evidence.checkpoint('pa33', output)
            self.assertFalse(json.loads(output.read_text())['stage_report']['current'])
            self.report(root, {'cppgm++':'old'})
            evidence.checkpoint('pa33', output)
            self.assertFalse(json.loads(output.read_text())['stage_report']['current'])

    def test_strict_snapshot_still_requires_successful_final_receipts(self):
        with self.workspace() as (root, binaries):
            self.report(root, binaries)
            evidence.checkpoint('pa33', root/'checkpoint.json')
            with self.assertRaises(FileNotFoundError):
                evidence.snapshot('pa33', root/'final.json')
            self.assertFalse((root/'final.json').exists())

    def test_quality_review_does_not_produce_an_acceptance_receipt(self):
        with patch.object(evidence, 'cached_gate') as gate, \
                patch.object(clone_quality, 'run', return_value=(0,b'',b'')) as run, \
                patch.object(sys,'argv',['clone_quality.py','--review']), \
                contextlib.redirect_stdout(io.TextIOWrapper(io.BytesIO())):
            self.assertEqual(clone_quality.main(), 0)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(len(commands), 3)
            self.assertTrue(any(command[1]=='clippy' for command in commands))
            self.assertFalse(any(command[:2]==['cargo','test'] for command in commands))
            gate.assert_not_called()


def common_key(context):
    return clone_common.digest(evidence.encoded(evidence.inputs(context)))


if __name__=='__main__':unittest.main()
