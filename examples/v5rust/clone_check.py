#!/usr/bin/env python3
"""Protected assignment gates with frozen anchors and added course cases."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import cache
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib

from clone_common import (ARTIFACTS, CONTROL, REFERENCE, ROOT, SETTINGS, TOOLS,
                          candidate_path, clean_env, digest, file_digest, run, run_course, write_json)

ACTIVE_STAGE = 1


@cache
def manifest():
    return json.loads((CONTROL / "manifest.json").read_text())


def build():
    code, out, err = run(["cargo", "build", "--manifest-path", "dev/Cargo.toml",
                          "--workspace", "--release", "--locked"], timeout=1800)
    if code:
        sys.stdout.buffer.write(out + err)
        raise RuntimeError("Rust workspace build failed")


def preflight():
    frozen = manifest()
    case_relocations(frozen)
    for name, expected in frozen["protected"].items():
        path = ROOT / name
        if not path.is_file() or file_digest(path) != expected:
            raise RuntimeError(f"protected scaffold/input changed: {name}")
    for tool, expected in frozen["oracle_tools"].items():
        if file_digest(REFERENCE / "dev" / tool) != expected:
            raise RuntimeError(f"oracle tool changed: {tool}")
    for name, expected in frozen["oracle_sources"].items():
        if file_digest(REFERENCE / name) != expected:
            raise RuntimeError(f"oracle source changed: {name}")
    if (ROOT / "dev/build.rs").exists():
        raise RuntimeError("compiler build.rs needs a reviewed scaffold update")
    cargo = tomllib.loads((ROOT / "dev/Cargo.toml").read_text())
    if cargo.get("workspace", {}).get("lints") != frozen["workspace_lints"]:
        raise RuntimeError("workspace lint policy changed")
    if cargo.get("lints", {}).get("workspace") is not True:
        raise RuntimeError("compiler package must inherit workspace lints")
    for tool in TOOLS:
        path = candidate_path(tool)
        if not path.is_file() or path.read_bytes()[:4] != b"\x7fELF":
            raise RuntimeError(f"missing Rust binary: {path}; run make build")
        if path.resolve().is_relative_to(REFERENCE):
            raise RuntimeError("candidate tool resolves to the C++ oracle")
    print("Clone input, tool routing and oracle integrity: PASS")


def routes(stage):
    number = int(stage[2:])
    primary = {1: "pptoken", 2: "posttoken", 3: "ppexpr", 4: "preproc",
               8: "lowir", 9: "abimangle", 24: "lowir2native", 32: "lowiropt",
               33: "lowir2native"}.get(number, "cppgm++")
    adapter = lambda tool: str(CONTROL / "bin" / tool)
    backend = adapter("lowir2native") if max(number, ACTIVE_STAGE) >= 24 else str(REFERENCE / "dev/lowir2native")
    return ["CXX=/usr/bin/g++", "CPPGM_HOST_CXX=/usr/bin/g++", "CPPGM_TEST_RUNNER=0",
            "CPPGM_SKIP_DEV_REBUILD=1", "TEST_DEPS=", "RUN_CHECK_DEPS=",
            "CPPGM_TEST_APP=" + adapter(primary), "NATIVE_REFERENCE_APP=" + backend,
            "LOWIROPT_APP=" + adapter("lowiropt"),
            "LOWIR2NATIVE_APP=" + adapter("lowir2native"),
            "CPPGM_DRIVER_APP=" + adapter("cppgm++"),
            "CPPGM_LOWIR_BEHAVIOR_APP=" + backend,
            "CPPGM_CPPGM_APP=" + adapter("cppgm++"),
            "CPPGM_LOWIROPT_APP=" + adapter("lowiropt"),
            "CPPGM_LOWIR2NATIVE_APP=" + adapter("lowir2native")]


def execute_case(stage, case, self_check=False):
    identifier = digest((stage + "/" + case).encode())[:20]
    directory = ARTIFACTS / "cases" / stage / identifier
    directory.mkdir(parents=True, exist_ok=True)
    trace = directory / "trace.jsonl"
    trace.unlink(missing_ok=True)
    shutil.rmtree(directory / "mismatches", ignore_errors=True)
    env = clean_env()
    env["V5RUST_TRACE"] = str(trace)
    # Focused compare workers otherwise may print FAIL yet return zero when
    # KEEP_GOING is explicitly set. Cases are already independent parallel jobs.
    env["KEEP_GOING"] = "0"
    if self_check:
        env["V5RUST_ORACLE_SELF_CHECK"] = "1"
    extra = []
    if stage in ("pa32", "pa33") and case.startswith("tests/regression/"):
        parts = case.split("/")
        if parts[2] in ("o0", "o1", "o2", "o3"):
            extra.append(parts[2].upper() + "_TEST_ROOT=" + "/".join(parts[:3]))
        elif parts[2] in ("driver", "behavior") and parts[3] in ("o0", "o1", "o2", "o3"):
            extra.append(parts[2].upper() + "_" + parts[3].upper() + "_TEST_ROOT=" + "/".join(parts[:4]))
    command = ["make", "--no-print-directory", "-s", "-C", stage,
               "check", "TEST=" + case, *routes(stage), *extra]
    cwd = ROOT
    if stage == "pa32" and case == "tests/regression/controls/537-o3-addressed-scalar-slot.t":
        # This fixture's owner is in test-regression, but the inherited focused
        # CHECK_RUN table omits its route. Invoke that same owning checker.
        command = ["perl", "../scripts/check_lowir_addressed_scalar_slots.pl",
                   str(CONTROL / "bin/lowiropt"), str(CONTROL / "bin/cppgm++"), case]
        cwd = ROOT / stage
    code, out, err = run(command, cwd=cwd, env=env, timeout=240)
    (directory / "course.log").write_bytes(out + err)
    records = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
    passed = code == 0 and bool(records) and all(record["match"] for record in records)
    return {"case": case, "passed": passed, "course_exit": code,
            "invocations": len(records), "log": str(directory / "course.log"),
            "trace": str(trace)}


def stage_cases(stage):
    # Frozen anchors remain required even if a file disappears. New executed
    # regressions must also enter differential checks and identity preservation.
    frozen = manifest()["stages"][stage]
    discovered = {path.relative_to(ROOT / stage).as_posix()
                  for path in (ROOT / stage / "tests").rglob("*.t")
                  if path.is_file() and "debuginfo" not in path.relative_to(ROOT / stage).parts}
    return [*frozen, *sorted(discovered - set(frozen))]


def stage_check(stage, self_check=False, *, summarize=True):
    if stage == "pa34":
        from clone_bootstrap import progress
        return progress()
    cases = stage_cases(stage)
    print(f"===== {stage} =====", flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda case: execute_case(stage, case, self_check), cases))
    for result in results:
        verdict = "PASS (1/1)" if result["passed"] else "FAIL (0/1)"
        print(f"clone/{stage}/{result['case']}: {verdict}")
        if not result["passed"]:
            print(f"  evidence: {result['trace']} ; {result['log']}")
    write_json(ARTIFACTS / "results" / (stage + ".json"), {
        "stage": stage, "manifest_sha256": file_digest(CONTROL / "manifest.json"),
        "binaries": {tool: file_digest(candidate_path(tool)) for tool in TOOLS},
        "results": results})
    passed = sum(result["passed"] for result in results)
    if summarize:
        print(f"===== TEST SUMMARY: {passed} / {len(results)} TESTS PASSED =====")
    return passed == len(results)


def passing_targets(status, stage):
    return {target["name"] for entry in status.get("stages", []) if entry["name"] == stage
            for target in entry.get("targets", []) if target.get("status") == "pass"}


def case_relocations(frozen):
    """Validate owner-reviewed identity changes against the frozen inventory."""
    relocations = frozen.get("case_identity_relocations", {})
    anchors = {f"clone/{stage}/{case}" for stage, cases in frozen["stages"].items()
               for case in cases}
    if not isinstance(relocations, dict):
        raise ValueError("case identity relocations must be a mapping")
    pattern = r"clone/pa(?:[1-9]|[12][0-9]|3[0-3])/tests/[^\s]+\.t"
    for old, new in relocations.items():
        if (not isinstance(old, str) or not isinstance(new, str)
                or not re.fullmatch(pattern, old) or not re.fullmatch(pattern, new)
                or any(part in (".", "..", "") for name in (old, new) for part in name.split("/"))
                or old in anchors or new not in anchors):
            raise ValueError(f"invalid case identity relocation: {old!r} -> {new!r}")
    return relocations


def preserve(stage):
    state_dir = Path(SETTINGS["state_dir"])
    current_log = state_dir / "last-test.log"
    if not current_log.exists():
        print("No Ralph check yet; preservation begins with its first result.")
        return True
    current = set(re.findall(r"^(clone/[^\n]+): PASS \(1/1\)$", current_log.read_text(), re.M))
    required = set()
    state_file = state_dir / "state.json"
    if state_file.exists():
        required |= passing_targets(json.loads(state_file.read_text()).get("lastTestStatus", {}), stage)
    events = state_dir / "events/run.jsonl"
    if events.exists():
        with events.open() as stream:
            for line in stream:
                try:
                    event = json.loads(line).get("event", {})
                except json.JSONDecodeError:
                    continue
                if event.get("action") == "checked":
                    required |= passing_targets(event.get("phaseStatus", {}).get("testStatus", {}), stage)
    relocations = case_relocations(manifest())
    canonical = set()
    for target in sorted(required):
        replacement = relocations.get(target, target)
        if replacement != target:
            print(f"Reviewed case relocation: {target} -> {replacement}")
        if replacement == target or replacement.split("/", 2)[1] == stage:
            canonical.add(replacement)
    required = canonical
    missing = sorted(required - current)
    for target in missing:
        print("Previously passing case regressed:", target)
    print(f"Case identity preservation: {len(required) - len(missing)}/{len(required)}")
    return not missing


def course(stage, target="test"):
    jobs = SETTINGS.get("course_workers", 8)
    if type(jobs) is not int or jobs < 1:
        raise ValueError("course_workers must be a positive integer")
    directory = ARTIFACTS / "course" / stage / target
    directory.mkdir(parents=True, exist_ok=True)
    trace = directory / "trace.jsonl"
    trace.unlink(missing_ok=True)
    shutil.rmtree(directory / "mismatches", ignore_errors=True)
    env = clean_env()
    env["CPPGM_TEST_JOBS"] = str(jobs)
    env["V5RUST_TRACE"] = str(trace)
    course_passed = run_course(["make", "--no-print-directory", "-s", target, *routes(stage)],
                               cwd=ROOT / stage, artifacts=directory, env=env)
    records = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
    passed = course_passed and bool(records) and all(record["match"] for record in records)
    print(f"{stage} {target}: {'PASS' if passed else 'FAIL'}; {directory}")
    return passed


def ownership_complete():
    lines = (ROOT / "docs/port/source-map.tsv").read_text().splitlines()
    pending = []
    for line in lines[1:]:
        fields = line.split("\t")
        if len(fields) != 3 or not fields[1] or fields[2] != "complete":
            pending.append(fields[0])
            continue
        if not all((ROOT / owner).is_file() for owner in fields[1].split(",")):
            pending.append(fields[0])
    if set(line.split("\t")[0] for line in lines[1:]) != set(manifest()["source_responsibilities"]):
        raise RuntimeError("source ownership census changed")
    if pending:
        print("Incomplete source responsibilities:", ", ".join(pending[:20]))
    return not pending


def main():
    global ACTIVE_STAGE
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["preflight", "stage", "prior", "through", "case",
                                         "preserve", "course", "release", "oracle-self-check"])
    parser.add_argument("stage", nargs="?", default="pa1")
    parser.add_argument("case", nargs="?")
    args = parser.parse_args()
    if not re.fullmatch(r"pa(?:[1-9]|[12][0-9]|3[0-4])", args.stage):
        parser.error("stage must be pa1 through pa34")
    ACTIVE_STAGE = int(args.stage[2:])
    if args.mode == "preserve":
        return 0 if preserve(args.stage) else 1
    build()
    preflight()
    if args.mode == "preflight":
        return 0
    if args.mode == "case":
        if args.case not in stage_cases(args.stage):
            parser.error("case is not in the stage inventory")
        result = execute_case(args.stage, args.case)
        print(json.dumps(result, indent=2))
        return 0 if result["passed"] else 1
    if args.mode in ("stage", "oracle-self-check"):
        return 0 if stage_check(args.stage, args.mode == "oracle-self-check") else 1
    if args.mode == "course":
        return 0 if course(args.stage) else 1
    if args.mode == "release":
        passed = all([course(stage, "test-debuginfo") for stage in ("pa8", "pa32", "pa33")])
        return 0 if ownership_complete() and passed else 1
    limit = int(args.stage[2:]) - (1 if args.mode == "prior" else 0)
    passed = True
    for number in range(1, limit + 1):
        passed = stage_check(f"pa{number}", summarize=False) and passed
        if number <= 33:
            passed = course(f"pa{number}") and passed
    if limit == 0:
        print("No earlier assignments are due: PASS")
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("clone gate infrastructure error:", error, file=sys.stderr)
        sys.exit(2)
