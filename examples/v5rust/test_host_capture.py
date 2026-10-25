"""Execute the reviewed build hook against controlled empty-input host probes."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which("rustc"), "Rust compiler required")
class HostCaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.directory.name)
        source = Path(__file__).parent / "build_support"
        (cls.root / "build_support").mkdir()
        shutil.copy2(source / "build.rs", cls.root / "build.rs")
        shutil.copy2(source / "host_configuration.rs", cls.root / "build_support/host_configuration.rs")
        cls.executable = cls.root / "capture"
        subprocess.run(["rustc", "--edition=2024", str(cls.root / "build.rs"), "-o", str(cls.executable)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def capture(self, command, flags="", **env):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([str(self.executable)], capture_output=True, env={
                **os.environ, "OUT_DIR": directory, "CPPGM_BUILD_HOST_CXX": command,
                "CPPGM_STDLIB_FLAGS": flags, **env}, check=True)
            return {p.name.removeprefix("cppgm-host-"): p.read_bytes() for p in Path(directory).iterdir()}, result.stdout

    def test_success_strict_split_includes_and_query_bytes(self):
        host = self.root / "fake host"
        host.write_text('''#!/usr/bin/python3
import os, sys
assert sys.stdin.read() == ''
args = sys.argv[1:]
assert args[0] == '-DSPACE=a b'
if '-dM' in args:
    print('#define STRICT 1' if '-std=c++11' in args else '#define GNU 1')
elif '-dumpmachine' in args: print('target-test')
elif '-dumpversion' in args: print('99.2')
elif '-print-search-dirs' in args: print('libraries: =/one:/two')
else:
    print('#include <...> search starts here:')
    print(' /one')
    print(' /one', file=sys.stderr)
    print(' /skip (framework directory)', file=sys.stderr)
    print(' /two', file=sys.stderr)
    print('End of search list.', file=sys.stderr)
    sys.exit(1)
''')
        host.chmod(0o755)
        flags="'-DSPACE=a b'"
        data, log = self.capture("'" + str(host) + "'", flags)
        self.assertEqual(data['macros'], b'#define GNU 1\n')
        self.assertEqual(data['strict'], b'#define STRICT 1\n')
        self.assertEqual(data['includes'], b'/one\n/two')
        self.assertEqual(data['target'], b'target-test\n')
        self.assertEqual(data['version'], b'99.2\n')
        self.assertEqual(data['search'], b'libraries: =/one:/two\n')
        self.assertEqual(data['flags'], flags.encode())
        self.assertIn(b'cargo:rerun-if-env-changed=CPPGM_BUILD_HOST_CXX', log)
        self.assertIn(b'cargo:rerun-if-env-changed=CPPGM_STDLIB_FLAGS', log)

    def test_unavailable_host_uses_reference_fallbacks(self):
        data, _ = self.capture('/nonexistent/host')
        self.assertEqual(data['macros'], b'')
        self.assertEqual(data['strict'], b'')
        self.assertEqual(data['includes'], b'')
        self.assertEqual(data['target'], b'x86_64-unknown-linux-gnu\n')
        self.assertEqual(data['version'], b'11\n')
        self.assertEqual(data['search'], b'')

    def test_failed_strict_capture_reuses_gnu(self):
        host = self.root / 'strict-failure'
        host.write_text("#!/bin/sh\ncase \"$*\" in *-std=c++11*) exit 1;; *-dM*) echo '#define GNU 1';; esac\n")
        host.chmod(0o755)
        data, _ = self.capture(str(host))
        self.assertEqual(data['strict'], data['macros'])
        self.assertEqual(data['macros'], b'#define GNU 1\n')

    @unittest.skipUnless(shutil.which("cargo"), "Cargo required")
    def test_cargo_rebuilds_capture_when_configuration_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            templates = Path(__file__).parent / 'build_support'
            (root / 'build_support').mkdir()
            (root / 'src').mkdir()
            for name in ['build.rs', 'builtin_host_configuration.rs']:
                shutil.copy2(templates / name, root / name)
            shutil.copy2(templates / 'host_configuration.rs', root / 'build_support/host_configuration.rs')
            (root / 'Cargo.toml').write_text('[package]\nname="host-capture-test"\nversion="0.1.0"\nedition="2024"\n[workspace]\n')
            (root / 'src/main.rs').write_text('''#[path="../builtin_host_configuration.rs"]
pub mod captured;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    print!("{}", std::str::from_utf8(captured::TARGET)?);
    Ok(())
}
''')
            host = root / 'host'
            host.write_text('#!/bin/sh\ncase "$*" in *-dumpmachine*) echo "$1";; esac\n')
            host.chmod(0o755)
            for flags in ['first', 'second']:
                result = subprocess.run(['cargo', 'run', '--quiet', '--offline'], cwd=root, capture_output=True,
                    env={**os.environ, 'CARGO_TARGET_DIR': str(root/'target'),
                         'CPPGM_BUILD_HOST_CXX': str(host), 'CPPGM_STDLIB_FLAGS': flags}, check=True)
                self.assertEqual(result.stdout, (flags + '\n').encode())


if __name__ == '__main__':
    unittest.main()
