#!/usr/bin/env python3
"""Convert a clean V5 student checkout to an empty safe Rust implementation."""
import json
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
BASE = Path('/home/vishvananda/work')
PRIVATE = BASE / 'private/v5scratch'
ROOT = PRIVATE / 'checkout'
CONTROL = BASE / 'v5scratch-control'
REVISION = '4fc4f61d8897f09293a2ef9202fd49373c602a29'
TOOLS = ('pptoken', 'posttoken', 'ppexpr', 'preproc', 'cppgm++', 'abimangle', 'lowir', 'lowiropt', 'lowir2native')
MODULES = ('lex', 'preprocess', 'syntax', 'sema', 'types', 'abi', 'lower', 'lowir', 'opt', 'native', 'driver', 'support')


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def json_file(path, value):
    write(path, json.dumps(value, indent=2) + '\n')
def workspace():
    manifest = '''[workspace]
members = ["."]
resolver = "3"

[package]
name = "cppgm-rust"
version = "0.1.0"
edition = "2024"
rust-version = "1.98"
publish = false

[lib]
path = "src/lib.rs"

[lints]
workspace = true

[workspace.lints.rust]
unsafe_code = "forbid"
unused_must_use = "deny"
unfulfilled_lint_expectations = "deny"

[workspace.lints.clippy]
all = { level = "warn", priority = -1 }
pedantic = { level = "warn", priority = -1 }
unwrap_used = "deny"
expect_used = "deny"
panic = "deny"
todo = "deny"
unimplemented = "deny"
dbg_macro = "deny"
exit = "deny"
mem_forget = "deny"
large_stack_arrays = "warn"
large_stack_frames = "warn"
too_many_lines = "warn"
excessive_nesting = "warn"
'''
    for tool in TOOLS:
        name = "cppgm" if tool == "cppgm++" else tool
        manifest += f'\n[[bin]]\nname = "{name}"\npath = "bin/{name}.rs"\n'
        write(ROOT / f"dev/bin/{name}.rs", f'''fn main() -> std::process::ExitCode {{
    cppgm_rust::driver::run_tool("{tool}")
}}
''')
        (ROOT / "dev" / tool).symlink_to("../obj/rust/release/" + name)
    write(ROOT / "dev/Cargo.toml", manifest)
    write(ROOT / "dev/src/lib.rs", "//! Safe Rust implementation of the CPPGM compiler tools.\n\n" +
          "\n".join(f"pub mod {module};" for module in sorted(MODULES)) + "\n")
    for module in MODULES:
        write(ROOT / f"dev/src/{module}/mod.rs", f"//! {module.title()} phase; see `spec.md` and the student handout.\n")
    write(ROOT / "dev/src/driver/mod.rs", '''//! Command-line boundary shared by the nine compiler tools.

/// Return the distinct scaffold status until this tool is implemented.
#[must_use]
pub fn run_tool(tool: &str) -> std::process::ExitCode {
    eprintln!("{tool}: Rust implementation is not implemented yet");
    std::process::ExitCode::from(86)
}
''')
    write(ROOT / "dev/clippy.toml", '''too-many-lines-threshold = 240
excessive-nesting-threshold = 6
allow-unwrap-in-tests = true
allow-expect-in-tests = true
allow-panic-in-tests = true
''')
    write(ROOT / "rust-toolchain.toml", '''[toolchain]
channel = "1.98.0"
profile = "minimal"
components = ["clippy", "rustfmt"]
''')
    write(ROOT / ".cargo/config.toml", '''[build]
target-dir = "obj/rust"
''')
    json_file(ROOT / "scripts/rust-module-roles.json", {})
    write(ROOT / "dev/Makefile", '''TOOLS = pptoken posttoken ppexpr preproc cppgm++ abimangle lowir lowiropt lowir2native
.PHONY: all $(TOOLS)
all $(TOOLS):
\tCARGO_HOME=$(abspath ../../cache/cargo) CARGO_TARGET_DIR=$(abspath ../obj/rust) cargo build --manifest-path Cargo.toml --workspace --release --locked
\t@for tool in $(TOOLS); do binary=$$tool; if [ "$$tool" = "cppgm++" ]; then binary=cppgm; fi; ln -sfn ../obj/rust/release/$$binary $$tool; done
''')

def main():
    if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() != REVISION:
        raise SystemExit('Scaffold requires the pinned clean V5 student base')
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT).strip():
        raise SystemExit('Scaffold requires a clean checkout')
    if (ROOT / 'dev/Cargo.toml').exists() or CONTROL.exists():
        raise SystemExit('Refusing to overwrite an existing scaffold/control directory')
    # Preserve supplied vocabulary as student handout material, outside production.
    starter = ROOT / 'docs/cpp-starter'
    starter.mkdir(parents=True)
    shutil.copytree(ROOT / 'dev/src', starter / 'src')
    for path in (ROOT / 'dev').glob('*.cpp'):
        shutil.move(path, starter / path.name)
    shutil.rmtree(ROOT / 'dev/src')
    workspace()
    # Existing reference wrappers still fetch the course's pinned binary bundle.
    makefile = ROOT / 'Makefile'
    text = makefile.read_text().replace('export CPPGM_TEST_RUNNER ?= 1', 'export CPPGM_TEST_RUNNER ?= 0')
    text = text.replace('export CPPGM_TEXT_TEST_TIMEOUT_SEC', 'export CPPGM_BATCH_TESTS := 0\nexport CPPGM_TEXT_TEST_TIMEOUT_SEC', 1)
    text += '''
# Rust student build/quality; the assignment test/report targets are unchanged.
export CARGO_HOME := $(abspath ../cache/cargo)
export CARGO_TARGET_DIR := $(CURDIR)/obj/rust
export CLIPPY_CONF_DIR := $(CURDIR)/dev
.PHONY: rust-quality audit-rust
rust-quality:
\tpython3 /home/vishvananda/work/v5scratch-control/student_quality.py
audit-rust:
\t/home/vishvananda/work/v5scratch-control/venv/bin/python /home/vishvananda/work/v5scratch-control/rust_audit.py --root $(CURDIR)
'''
    makefile.write_text(text)
    for name in ['candidate-AGENTS.md', 'spec.md']:
        shutil.copyfile(HERE / name, ROOT / ('AGENTS.md' if name.startswith('candidate-') else name))
    shutil.copyfile(HERE / 'README.md', ROOT / 'RUST_STUDENT.md')
    readme = ROOT / 'README.md'
    readme.write_text('''# v5scratch: C++11 compiler implemented in Rust

This is the safe Rust student adaptation of the V5 assignments. Start with
[AGENTS.md](AGENTS.md), [the run guide](RUST_STUDENT.md) and [spec.md](spec.md).
The run ends after audited PA33; PA34/PA35 are deferred. The original student
course overview follows; its C++ build instructions are replaced by Cargo.

''' + readme.read_text())
    json_file(ROOT / 'SCAFFOLD_BASE.json', {
        'repository': 'https://github.com/vishvananda/cppgm-assignments',
        'tag': 'v5', 'commit': REVISION,
        'implementation': 'safe Rust student scaffold',
        'stop_after_audited_stage': 'pa33',
        'acceptance': 'V5 student course contracts; no exact compiler clone comparison',
    })
    testing = ROOT / 'TESTING_AND_REFERENCES.md'
    testing.write_text('''Rust adaptation: use `make build`, `make rust-quality` and `make audit-rust`.
The PA1–PA33 course commands below are retained; C++ starter build and embedded
batch-worker instructions are replaced by Cargo and ordinary course workers.
PA34/PA35 are deferred. See `AGENTS.md` and `RUST_STUDENT.md`.

''' + testing.read_text())
    (ROOT / '.gitignore').write_text((ROOT / '.gitignore').read_text() + '\n/target/\n/obj/\n**/__pycache__/\n')
    CONTROL.mkdir(mode=0o700)
    for name in ['codex-v5scratch', 'student_quality.py', 'rust_audit.py']:
        shutil.copyfile(HERE / name, CONTROL / name)
        (CONTROL / name).chmod(0o755)
    subprocess.run(['python3', '-m', 'venv', str(CONTROL / 'venv')], check=True)
    subprocess.run([str(CONTROL / 'venv/bin/pip'), 'install', 'tree-sitter==0.25.2', 'tree-sitter-rust==0.24.2'], check=True)
    for file in HERE.glob('v5scratch.*'):
        shutil.copyfile(file, BASE / file.name)
    (BASE / 'v5scratch').symlink_to(ROOT)
    for key in ['user.name', 'user.email']:
        value = subprocess.check_output(['git', 'config', '--get', key], text=True).strip()
        subprocess.run(['git', 'config', '--local', key, value], cwd=ROOT, check=True)
    subprocess.run(['cargo', 'generate-lockfile', '--manifest-path', 'dev/Cargo.toml'], cwd=ROOT, check=True,
                   env=os.environ | {'CARGO_HOME': str(PRIVATE / 'cache/cargo')})
    print('Empty Rust workspace installed over student assignments; run remains unstarted.')


if __name__ == '__main__':
    main()
