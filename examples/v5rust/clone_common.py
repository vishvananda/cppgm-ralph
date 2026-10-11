"""Shared paths and deterministic subprocess handling for the clone gates."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess

CONTROL = Path(__file__).resolve().parent
SETTINGS = json.loads((CONTROL / "settings.json").read_text()) if (CONTROL / "settings.json").exists() else {}
ROOT = Path(SETTINGS.get("checkout", ".")).resolve()
REFERENCE = Path(SETTINGS.get("reference", ".")).resolve()
ARTIFACTS = Path(SETTINGS.get("artifacts", "/tmp/v5rust-checks"))
TOOLS = ("pptoken", "posttoken", "ppexpr", "preproc", "cppgm++", "abimangle", "lowir", "lowiropt", "lowir2native")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def clean_env():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("CPPGM_", "V5RUST_", "MAKE", "WRAPPED_"))}
    env.update(LC_ALL="C", TZ="UTC", CPPGM_HOST_CXX="/usr/bin/g++",
               CPPGM_TEST_JOBS="1", CPPGM_BATCH_TESTS="0",
               CPPGM_LOWIR_DIRECT_TEXT_COMPARE="1", KEEP_GOING="1",
               CARGO_HOME=str(ROOT.parent / "cache/cargo"),
               CARGO_TARGET_DIR=str(ROOT / "obj/rust"),
               CLIPPY_CONF_DIR=str(ROOT / "dev"), CARGO_BUILD_WARNINGS="deny",
               PYTHONDONTWRITEBYTECODE="1")
    return env


def run(command, *, cwd=ROOT, env=None, stdin=b"", timeout=120):
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
