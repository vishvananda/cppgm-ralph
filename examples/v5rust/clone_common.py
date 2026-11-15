"""Shared paths and deterministic subprocess handling for the clone gates."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

CONTROL = Path(__file__).resolve().parent
SETTINGS = json.loads((CONTROL / "settings.json").read_text()) if (CONTROL / "settings.json").exists() else {}
ROOT = Path(SETTINGS.get("checkout", ".")).resolve()
REFERENCE = Path(SETTINGS.get("reference", ".")).resolve()
ARTIFACTS = Path(SETTINGS.get("artifacts", "/tmp/v5rust-checks"))
COURSE_LAYOUT = SETTINGS.get("course_layout", {})
DRIVER_TOOL = COURSE_LAYOUT.get("driver_tool", "cppgm++")
BOOTSTRAP_STAGE = COURSE_LAYOUT.get("bootstrap_stage", "pa34")
CORRECTNESS_STAGES = tuple(COURSE_LAYOUT.get("correctness_stages", [f"pa{n}" for n in range(1, 34)]))
DEBUG_STAGES = tuple(COURSE_LAYOUT.get("debug_stages", ["pa8", "pa32", "pa33"]))
IR_OPT_STAGE = 33 if COURSE_LAYOUT.get("id") == "v9" else 32
BACKEND_OPT_STAGE = IR_OPT_STAGE + 1
TOOLS = ("pptoken", "posttoken", "ppexpr", "preproc", DRIVER_TOOL, "abimangle", "lowir", "lowiropt", "lowir2native")


def primary_tool(number):
    return {1: "pptoken", 2: "posttoken", 3: "ppexpr", 4: "preproc", 8: "lowir",
            9: "abimangle", 24: "lowir2native", IR_OPT_STAGE: "lowiropt",
            BACKEND_OPT_STAGE: "lowir2native"}.get(number, DRIVER_TOOL)


def correctness_numbers(limit=None):
    return [int(stage[2:]) for stage in CORRECTNESS_STAGES
            if limit is None or int(stage[2:]) <= limit]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def clean_env():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("CPPGM_", "V5RUST_", "MAKE", "WRAPPED_"))}
    env.update(LC_ALL="C", TZ="UTC", NO_COLOR="1", CPPGM_HOST_CXX="/usr/bin/g++",
               CPPGM_BUILD_HOST_CXX=SETTINGS.get("build_host_cxx", "g++"),
               CPPGM_STDLIB_FLAGS=SETTINGS.get("build_stdlib_flags", ""),
               CPPGM_TEST_JOBS="1", CPPGM_BATCH_TESTS="0",
               CPPGM_LOWIR_DIRECT_TEXT_COMPARE="1", KEEP_GOING="1",
               CARGO_HOME=str(ROOT.parent / "cache/cargo"),
               CARGO_TARGET_DIR=str(ROOT / "obj/rust"),
               CLIPPY_CONF_DIR=str(ROOT / "dev"), CARGO_BUILD_WARNINGS="deny",
               PYTHONDONTWRITEBYTECODE="1")
    if SETTINGS.get("validation_path"):
        env["PATH"] = SETTINGS["validation_path"]
    return env


def run(command, *, cwd=ROOT, env=None, stdin=b"", timeout=120, stack_limit_bytes=None):
    if stack_limit_bytes is not None:
        # Exec a small child wrapper instead of preexec_fn: the checker also
        # starts subprocesses from threads. Preserve argv, cwd, env and stdin.
        wrapper = ("import os,resource,sys; "
                   "resource.setrlimit(resource.RLIMIT_STACK, "
                   "(int(sys.argv[1]),resource.getrlimit(resource.RLIMIT_STACK)[1])); "
                   "os.execvpe(sys.argv[2],sys.argv[2:],os.environ)")
        command = [sys.executable, "-c", wrapper, str(stack_limit_bytes), *map(str, command)]
    process = subprocess.Popen(command, cwd=cwd, env=env or clean_env(),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = process.communicate(stdin, timeout=timeout)
        return process.returncode, out, err
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        out, err = process.communicate()
        return 124, out, err + b"\nclone harness: timeout\n"


def run_course(command, *, cwd, artifacts, env=None):
    """Honor the course's keep-going failure markers and per-lane counts."""
    artifacts.mkdir(parents=True, exist_ok=True)
    counts = artifacts / "counts.txt"
    counts.unlink(missing_ok=True)
    marker = cwd / ".test_failed"
    marker.unlink(missing_ok=True)
    environment = dict(clean_env() if env is None else env)
    environment["CPPGM_TEST_COUNTS_FILE"] = str(counts)
    code, out, err = run(command, cwd=cwd, env=environment, timeout=3600)
    (artifacts / "course.log").write_bytes(out + err)
    totals = [line.split() for line in counts.read_text().splitlines()] if counts.exists() else []
    counts_passed = all(len(row) == 2 and all(value.isdecimal() for value in row)
                        and int(row[0]) == int(row[1]) for row in totals)
    passed = code == 0 and not marker.exists() and counts_passed
    write_json(artifacts / "course-result.json", {
        "exit": code, "failure_marker": marker.exists(), "counts": totals, "passed": passed})
    return passed


def candidate_path(tool):
    return ROOT / "obj/rust/release" / ("cppgm" if tool == "cppgm++" else tool)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)
