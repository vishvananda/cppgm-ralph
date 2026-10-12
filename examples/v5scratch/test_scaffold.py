"""Regressions for the scratch run's restricted source view."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('scratch_sandbox', Path(__file__).with_name('sandbox.py'))
sandbox = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sandbox)


class SandboxTests(unittest.TestCase):
    def test_missing_read_only_root_fails_closed(self):
        for args in [[], ['--bind', '/', '/'], ['--ro-bind', '/elsewhere', '/']]:
            with self.assertRaises(ValueError):
                sandbox.sandbox_args(args)

    def test_home_is_hidden_before_only_required_paths_are_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / 'home'
            control, provider = home / 'control', home / 'provider'
            runtime = home / 'codex-runtime'
            for path in [home / '.rustup', home / '.cargo/bin', runtime, control, provider]:
                path.mkdir(parents=True)
            root = home / 'work/private/v5scratch/checkout'
            args = ['--ro-bind','/','/','--bind',str(root.parent),str(root.parent),'--chdir',str(root),'--','true']
            with patch.multiple(sandbox, HOME=home, CONTROL=control, PROVIDER=provider, ROOT=root, BASE=home/'work', CODEX_RUNTIME=runtime):
                result = sandbox.sandbox_args(args)
            self.assertEqual(result[:5], ['--ro-bind','/','/','--tmpfs','/home'])
            self.assertLess(result.index('--tmpfs'), result.index('--bind'))
            self.assertLess(result.index('--bind'), result.index('--remount-ro'))
            self.assertIn(str(control), result)
            self.assertNotIn(str(home/'cppgm-extended'), result)
            self.assertEqual(result[-4:], ['--chdir',str(root),'--','true'])
            control.rmdir()
            with patch.multiple(sandbox, HOME=home, CONTROL=control, PROVIDER=provider, ROOT=root, BASE=home/'work', CODEX_RUNTIME=runtime):
                with self.assertRaisesRegex(ValueError,'missing required'):
                    sandbox.sandbox_args(args)


if __name__ == '__main__':
    unittest.main()
