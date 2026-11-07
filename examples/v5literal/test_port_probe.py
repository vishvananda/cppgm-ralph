"""Real probe commands preserve all exact comparison channels and fail closed."""
import contextlib
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import clone_common as common
from port_probe import run_recipe


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.reference = self.root / 'reference'
        (self.reference / 'dev/src').mkdir(parents=True)
        for name, value in [('ROOT', self.root), ('REFERENCE', self.reference),
                            ('ARTIFACTS', self.root / 'artifacts')]:
            self.stack.enter_context(patch.object(common, name, value))

    def execute(self, recipe):
        path = self.root / 'recipe.json'
        path.write_text(json.dumps(recipe))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return run_recipe(path)

    def python_recipe(self, code):
        return {'reference': ['{python}', '-c', code],
                'candidate': ['{python}', '-c', code], 'cases': [{'stdin': 'input\n'}]}

    def test_exact_streams_generated_bytes_and_explicit_rejection(self):
        code = 'import sys,pathlib;pathlib.Path("object.bin").write_bytes(sys.stdin.buffer.read());print("diagnostic",file=sys.stderr);sys.exit(1)'
        recipe = self.python_recipe(code)
        recipe.update(outputs=['object.bin'], cases=[{'stdin': 'input\n', 'exit': 1}])
        self.assertEqual(self.execute(recipe), 0)
        manifest = json.loads(next((self.root / 'artifacts').rglob('manifest.json')).read_text())
        self.assertEqual(manifest['cases'], 1)
        self.assertIn(str(self.root / 'recipe.json'), manifest['inputs'])

    def test_each_mismatch_channel_and_unexpected_exit_fails(self):
        for code in ['print("different")', 'import sys;print("different",file=sys.stderr)',
                     'import pathlib;pathlib.Path("object.bin").write_bytes(b"different")',
                     'raise SystemExit(1)']:
            recipe = self.python_recipe('from pathlib import Path;Path("object.bin").write_bytes(b"original")')
            candidate = 'from pathlib import Path;Path("object.bin").write_bytes(b"original");' + code
            recipe.update(candidate=['{python}', '-c', candidate], outputs=['object.bin'])
            self.assertEqual(self.execute(recipe), 1, code)

    def test_signals_panics_scaffold_and_escape_are_rejected(self):
        for code in [86, 101, 124, 137, -1]:
            recipe = self.python_recipe('pass'); recipe['cases'][0]['exit'] = code
            self.assertEqual(self.execute(recipe), 1)
        recipe = self.python_recipe('pass');recipe['outputs'] = ['../outside']
        self.assertEqual(self.execute(recipe), 1)

    def test_success_requires_declared_generated_outputs(self):
        recipe = self.python_recipe('pass');recipe['outputs'] = ['object.bin']
        self.assertEqual(self.execute(recipe), 1)

    def test_changed_declared_input_invalidates_success(self):
        source = self.root / 'input';source.write_text('before')
        recipe = self.python_recipe('from pathlib import Path;Path("{root}/input").write_text("after")')
        recipe['inputs'] = ['input']
        self.assertEqual(self.execute(recipe), 1)

    @unittest.skipUnless(shutil.which('g++') and shutil.which('rustc'), 'native probe toolchains')
    def test_cpp_includes_and_rust_build_with_real_compilers(self):
        (self.reference / 'dev/src/type.h').write_text('struct Value { int n; };\n')
        (self.root / 'observer.cpp').write_text('#include <cstdio>\nint main(){Value x{42};printf("%d\\n",x.n);}\n')
        (self.root / 'observer.rs').write_text('fn main(){println!("42");}\n')
        recipe = {'builds': [
            {'name': 'reference', 'language': 'cpp', 'sources': ['observer.cpp'],
             'force_include': ['{reference}/dev/src/type.h']},
            {'name': 'candidate', 'language': 'rust', 'sources': ['observer.rs']}],
            'reference': ['{out}/reference'], 'candidate': ['{out}/candidate'], 'cases': [{}]}
        self.assertEqual(self.execute(recipe), 0)
        manifest = json.loads(next((self.root / 'artifacts').rglob('manifest.json')).read_text())
        self.assertIn(str(self.reference / 'dev/src/type.h'), manifest['inputs'])
        self.assertEqual(len(manifest['commands']), 4)


if __name__ == '__main__':
    unittest.main()
