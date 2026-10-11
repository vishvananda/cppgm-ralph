#!/usr/bin/env python3
"""Populate the already provisioned, empty v5rust checkout and control bundle."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tomllib

HERE = Path(__file__).resolve().parent
BASE = Path("/home/vishvananda/work")
PRIVATE = BASE / "private/v5rust"
ROOT = PRIVATE / "checkout"
REFERENCE = BASE / "references/v5rust-cpp"
CONTROL = BASE / "v5rust-control"
REVISION = "905bd7e4412a2d77d88694fe6abc7f3e1c27bce1"
TOOLS = ("pptoken", "posttoken", "ppexpr", "preproc", "cppgm++", "abimangle", "lowir", "lowiropt", "lowir2native")
MODULES = ("lex", "preprocess", "syntax", "sema", "types", "abi", "lower", "lowir", "opt", "native", "driver", "support")


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def json_file(path, value):
    write(path, json.dumps(value, indent=2) + "\n")


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


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
        reference = ROOT / "dev" / (tool + "-ref")
        write(reference, f'#!/bin/sh\nexec "{REFERENCE}/dev/{tool}" "$@"\n')
        reference.chmod(0o755)
    write(ROOT / "dev/Cargo.toml", manifest)
    write(ROOT / "dev/src/lib.rs", "//! Safe Rust implementation of the CPPGM compiler tools.\n\n" +
          "\n".join(f"pub mod {module};" for module in sorted(MODULES)) + "\n")
    for module in MODULES:
        write(ROOT / f"dev/src/{module}/mod.rs", f"//! {module.title()} phase; see `CLONE_CONTRACT.md` and the C++ ownership ledger.\n")
    write(ROOT / "dev/src/driver/mod.rs", '''//! Command-line boundary shared by the nine compiler tools.

/// Return the distinct scaffold status until this tool is implemented.
#[must_use]
pub fn run_tool(tool: &str) -> std::process::ExitCode {
    eprintln!("{tool}: Rust port is not implemented yet");
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
''')


def documentation(tracked):
    for workflow in (ROOT / ".github/workflows").glob("*.yml"):
        workflow.unlink()
    shutil.copyfile(HERE / "rust.yml", ROOT / ".github/workflows/rust.yml")
    for source, destination in (("candidate-AGENTS.md", "AGENTS.md"), ("CLONE_CONTRACT.md", "CLONE_CONTRACT.md")):
        shutil.copyfile(HERE / source, ROOT / destination)
    shutil.copyfile("/home/vishvananda/cppgm-extended/docs/rust-clone-plan.md", ROOT / "docs/rust-clone-plan.md")
    write(ROOT / "README.md", '''# cppgm-rust

An exact, safe Rust port of the CPPGM C++ compiler implementation, driven by
the v5rust assignment loop. This is the initial scaffold; the compiler tools
return status 86 until implemented.

Read [CLONE_CONTRACT.md](CLONE_CONTRACT.md), [AGENTS.md](AGENTS.md),
[the conversion plan](docs/rust-clone-plan.md) and [ROADMAP.md](ROADMAP.md).
The C++ oracle is pinned to commit 905bd7e4412a2d77d88694fe6abc7f3e1c27bce1.
The original handouts, tests, regressions, architecture specification and
attribution are retained. See [NOTICE](NOTICE).

Use Rust naming conventions throughout the implementation: snake_case modules
and functions, UpperCamelCase types, SCREAMING_SNAKE_CASE constants, kebab-case
packages. Preserve externally observable C++ spellings and CLI tool names.

`make build`, `make lint`, `make audit-rust`, `make test-pa1`.
The installed protected gate configuration and C++ reference paths are recorded
in `scripts/clone/settings.json`. Reprovision those paths on another machine;
the repository contains no oracle binary or compiler fallback.

PA1-PA33 establish exact behavior. PA34 compiles the original C++ sources and
compares each object and all rebuilt tools with the C++ self-build fixed point.
PA35 is reference material, not an optimization objective for this port.
''')
    write(ROOT / "docs/port/source-map.tsv", "cpp_source\trust_owner\tstatus\n" +
          "".join(f"{name}\t\tpending\n" for name in tracked
                  if name.startswith("dev/") and name.endswith((".cpp", ".h"))))
    template = (HERE / "stage-plan.template.md").read_text()
    for stage in range(1, 35):
        write(ROOT / f"docs/port/pa{stage}.md", template.replace("PA_STAGE", f"PA{stage}"))
    write(ROOT / ".gitignore", (ROOT / ".gitignore").read_text() + '''
# Rust port and clone harness artifacts
/obj/
/target/
**/__pycache__/
/.test_failed
/.test_summary*
''')


def controls():
    settings = {"checkout": str(ROOT), "reference": str(REFERENCE),
                "artifacts": str(PRIVATE / "artifacts/clone"), "revision": REVISION,
                "state_dir": str(BASE / ".ralph/v5rust-gpt-6.1-sol-high")}
    (PRIVATE / "artifacts/clone").mkdir(parents=True, exist_ok=True)
    for directory in (CONTROL, ROOT / "scripts/clone"):
        directory.mkdir(parents=True, exist_ok=True)
        json_file(directory / "settings.json", settings)
        for source in HERE.glob("*.py"):
            if source.name != "scaffold.py":
                shutil.copyfile(source, directory / source.name)
    for tool in TOOLS:
        path = CONTROL / "bin" / tool
        write(path, f'#!/bin/sh\nexec python3 "{CONTROL}/clone_adapter.py" "{tool}" "$@"\n')
        path.chmod(0o755)
    launcher = CONTROL / "codex-v5rust"
    write(launcher, f'''#!/bin/sh
export CARGO_HOME='{PRIVATE}/cache/cargo'
export CARGO_TARGET_DIR='{ROOT}/obj/rust'
export CLIPPY_CONF_DIR='{ROOT}/dev'
exec /usr/local/bin/codex "$@"
''')
    launcher.chmod(0o755)
    write(ROOT / "scripts/clone_check.py", f'''#!/usr/bin/env python3
import os
import sys
os.execv(sys.executable, [sys.executable, "{CONTROL}/clone_check.py", *sys.argv[1:]])
''')
    makefile = f'''# Exact Rust clone: the assignment Makefiles remain the owning course harness.
EXPERIMENTAL_PAS ?= pa34 pa35
CHECK = python3 {CONTROL}/clone_check.py
export CARGO_HOME := $(abspath ../cache/cargo)
export CARGO_TARGET_DIR := $(CURDIR)/obj/rust
export CLIPPY_CONF_DIR := $(CURDIR)/dev
export CARGO_BUILD_WARNINGS := deny
.PHONY: all build lint audit-rust test test-harness inception test-debuginfo
all: build
build:
\tcargo build --manifest-path dev/Cargo.toml --workspace --release --locked
lint:
\tpython3 {CONTROL}/clone_quality.py
audit-rust:
\t{CONTROL}/venv/bin/python {CONTROL}/rust_audit.py --root $(CURDIR)
test: test-report-through-pa33
test-pa%:
\t$(CHECK) stage pa$*
course-pa%:
\t$(CHECK) course pa$*
test-report-through-pa%:
\t$(CHECK) through pa$*
test-debuginfo:
\t$(CHECK) release pa33
test-harness:
\t{CONTROL}/venv/bin/python -m unittest discover -s {CONTROL} -p 'test_*.py'
inception: build
\tpython3 {CONTROL}/clone_bootstrap.py --final
'''
    write(ROOT / "Makefile", makefile)


def configuration():
    checker = f"python3 {CONTROL}/clone_check.py"
    check = lambda command, **kwargs: {"command": command, "required": True, **kwargs}
    checks = {
        "preflight": check(checker + " preflight {{testStage}}"),
        "priorThroughTests": check(checker + " prior {{testStage}}", dependsOn=["preflight"]),
        "stageTests": check(checker + " stage {{testStage}}", primary=True, required=False, kind="test", dependsOn=["preflight"]),
        "rustQuality": check(f"python3 {CONTROL}/clone_quality.py", dependsOn=["preflight"]),
        "casePreservation": check(checker + " preserve {{testStage}}", dependsOn=["priorThroughTests"]),
        "stageProgress": check("ralph:current-stage-progress stageTests {{testStage}}", dependsOn=["priorThroughTests", "casePreservation", "rustQuality"]),
        "stageProgressPreserved": check("ralph:current-stage-progress stageTests {{testStage}} mode=preserve", dependsOn=["priorThroughTests", "casePreservation", "rustQuality"]),
        "stageComplete": check(checker + " stage {{testStage}}", primary=True, kind="test", dependsOn=["preflight"]),
        "courseSuite": check(checker + " course {{testStage}}", excludeStages=["pa34"], dependsOn=["stageComplete"]),
        "releaseChecks": check(checker + " release {{testStage}}", onlyStages=["pa33"], dependsOn=["stageComplete"]),
        "bootstrapProof": check(f"python3 {CONTROL}/clone_bootstrap.py --final", onlyStages=["pa34"], dependsOn=["stageComplete"]),
    }
    base_checks = ["preflight", "priorThroughTests", "stageTests", "rustQuality", "casePreservation"]
    phases = [
        {"name": "implement", "promptTemplate": "implement", "goalTemplate": "implement-goal",
         "promptTemplates": {"pa34": "pa34-implement"}, "goalTemplates": {"pa34": "pa34-implement-goal"},
         "checkpointOnRequiredChecks": True, "checkpointPhase": "checkpointAudit", "checkpointPhaseEvery": 3,
         "checks": [*base_checks, "stageProgress"]},
        {"name": "checkpointAudit", "promptTemplate": "checkpointAudit", "goalTemplate": "checkpointAudit-goal",
         "checkpointOnly": True, "runWhenChecksPass": True, "returnPhaseOnIncompletePrimary": "implement",
         "checks": [*base_checks, "stageProgressPreserved"]},
        {"name": "audit", "promptTemplate": "audit", "goalTemplate": "audit-goal",
         "promptTemplates": {"pa34": "pa34-audit"}, "goalTemplates": {"pa34": "pa34-audit-goal"},
         "runWhenChecksPass": True,
         "checks": ["preflight", "priorThroughTests", "stageComplete", "rustQuality", "casePreservation", "courseSuite", "releaseChecks", "bootstrapProof"]},
    ]
    config = {"baseDir": str(BASE), "workdir": str(BASE / "v5rust"), "useExistingWorkdir": True,
              "name": "v5rust", "assignmentLayout": "v5", "provider": "codex",
              "testCommand": checker + " stage paX", "checks": checks, "phases": phases,
              "extraStages": ["pa34"], "initialStage": "pa1", "stopAfterStage": "pa34", "maxTurns": 500,
              "stateBaseDir": str(BASE / ".ralph"), "model": "gpt-6.1-sol", "reasoningEffort": "high",
              "sandboxMode": "danger-full-access", "approvalPolicy": "never", "networkAccessEnabled": True,
              "webSearchEnabled": True, "sessionIsolation": {"enabled": True, "backend": "bwrap",
              "readOnlyRoot": True, "privateTmp": True, "privateWriteDir": str(PRIVATE),
              "privateWriteMaxBytes": 107374182400}, "additionalDirectories": [], "outputTailChars": 24000,
              "codexPath": str(CONTROL / "codex-v5rust"), "loopGoalsEnabled": True, "goalTokenBudget": None,
              "freshThreadPerTurn": True, "eventLogScope": "run", "resourceLimits": {"enabled": True,
              "backend": "systemd-run", "memoryMax": "64G", "memorySwapMax": "0", "oomGroup": False,
              "cleanupTimeoutSec": 2}}
    for destination in (HERE / "v5rust.config.json", BASE / "v5rust.config.json"):
        json_file(destination, config)
    for path in HERE.glob("v5rust.*.md"):
        shutil.copyfile(path, BASE / path.name)
        shutil.copyfile(path, CONTROL / path.name)


def freeze(tracked):
    protected = {}
    for name in tracked:
        if name.startswith(("pa", "scripts/", "shared/", "benchmarks/")) and (ROOT / name).is_file():
            protected[name] = sha(ROOT / name)
    for path in [ROOT / "Makefile", ROOT / "AGENTS.md", ROOT / "CLONE_CONTRACT.md",
                 ROOT / "rust-toolchain.toml", ROOT / "dev/frontend_source_sets.mk",
                 ROOT / "dev/clippy.toml", *list((ROOT / "scripts/clone").glob("*.py")),
                 ROOT / "scripts/clone_check.py"]:
        protected[path.relative_to(ROOT).as_posix()] = sha(path)
    stages = {}
    for number in range(1, 34):
        stage = f"pa{number}"
        stages[stage] = [name[len(stage) + 1:] for name in tracked if name.startswith(stage + "/tests/")
                         and name.endswith(".t")
                         and "/debuginfo/" not in name]
    frozen = {"revision": REVISION, "protected": protected, "stages": stages,
              "workspace_lints": tomllib.loads((ROOT / "dev/Cargo.toml").read_text())["workspace"]["lints"],
              "source_responsibilities": [name for name in tracked if name.startswith("dev/") and name.endswith((".cpp", ".h"))],
              "oracle_tools": {tool: sha(REFERENCE / "dev" / tool) for tool in TOOLS},
              "oracle_sources": {name: sha(REFERENCE / name) for name in tracked if name.startswith("dev/")}}
    json_file(CONTROL / "manifest.json", frozen)
    json_file(ROOT / "scripts/clone/manifest.json", frozen)


def main():
    if ROOT.exists():
        raise SystemExit(f"Refusing to overwrite {ROOT}")
    ROOT.mkdir()
    tracked = subprocess.check_output(["git", "-C", str(REFERENCE), "ls-files", "-z"]).decode().split("\0")[:-1]
    for name in tracked:
        if name.startswith("dev/") and name != "dev/frontend_source_sets.mk":
            continue
        source, target = REFERENCE / name, ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            target.symlink_to(source.readlink())
        else:
            shutil.copy2(source, target)
    workspace()
    documentation(tracked)
    controls()
    configuration()
    subprocess.run(["cargo", "generate-lockfile", "--manifest-path", str(ROOT / "dev/Cargo.toml")], check=True)
    freeze(tracked)
    (BASE / "v5rust").symlink_to(ROOT, target_is_directory=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(ROOT)], check=True)
    print("Created v5rust candidate and protected control bundle; not committed or launched.")


if __name__ == "__main__":
    main()
