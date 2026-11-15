#!/usr/bin/env python3
"""PA34: replay the original Makefile at identical paths for every generation."""
import json
from pathlib import Path
import shutil
import sys

from clone_common import (ARTIFACTS, CONTROL, REFERENCE, ROOT, TOOLS, candidate_path,
                          BOOTSTRAP_STAGE, CORRECTNESS_STAGES, DEBUG_STAGES, DRIVER_TOOL,
                          primary_tool, correctness_numbers,
                          file_digest, run, run_course, write_json)

BASE = ROOT / "obj/bootstrap"
WORK = BASE / "work"
OBJECTS = WORK / f"obj/{BOOTSTRAP_STAGE}/selfhost"
BINS = WORK / f"obj/{BOOTSTRAP_STAGE}/bin/selfhost"
SAVED = BASE / "generations"


def prepare():
    (WORK / BOOTSTRAP_STAGE).mkdir(parents=True, exist_ok=True)
    for name in ("dev", "scripts", "shared"):
        target = WORK / name
        if not target.exists():
            target.symlink_to(REFERENCE / name, target_is_directory=True)
    shutil.copyfile(REFERENCE / BOOTSTRAP_STAGE / "Makefile", WORK / BOOTSTRAP_STAGE / "Makefile")
    for number in correctness_numbers():
        target = WORK / f"pa{number}"
        if not target.exists():
            shutil.copytree(REFERENCE / f"pa{number}", target,
                            ignore=shutil.ignore_patterns("*.my*", "*.check*", ".test_failed"))
    SAVED.mkdir(parents=True, exist_ok=True)


def recipe(compiler, target="all"):
    return ["make", "--no-print-directory", "-k", "-j1", "-C", str(WORK / BOOTSTRAP_STAGE), target,
            "CXX=" + str(compiler), "CPPGM_HOST_CXX=/usr/bin/g++",
            "INCEPTION_COMPILER_FLAVOR=selfhost", "INCEPTION_COMPARE_OBJECTS=0",
            "INCEPTION_BUILD_MISSING_FIRST=0", "INCEPTION_BUILD_JOBS=8",
            "INCEPTION_OBJECT_BUILD_JOBS=8", "INCEPTION_SELFHOST_OPT_LEVEL=3",
            f"INCEPTION_OBJ_ROOT_BASE=../obj/{BOOTSTRAP_STAGE}", "CPPGM_TEST_RUNNER=1"]


def inventory(directory):
    return {path.relative_to(directory).as_posix(): file_digest(path)
            for path in sorted(directory.rglob("*.o"))}


def generation(name, compiler):
    # All branches write the same paths. Saved generations are never inputs to
    # a failed candidate build. Changing compiler invalidates every object.
    shutil.rmtree(OBJECTS, ignore_errors=True)
    shutil.rmtree(BINS, ignore_errors=True)
    code, out, err = run(recipe(compiler), timeout=21600)
    (ARTIFACTS / f"bootstrap-{name}.log").write_bytes(out + err)
    destination = SAVED / name
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True)
    if OBJECTS.exists():
        shutil.copytree(OBJECTS, destination / "objects")
    if BINS.exists():
        shutil.copytree(BINS, destination / "bin")
    objects = inventory(OBJECTS)
    binaries = {tool: file_digest(BINS / (tool + "-self")) for tool in TOOLS
                if (BINS / (tool + "-self")).exists()}
    result = {"name": name, "compiler": str(compiler), "compiler_sha256": file_digest(compiler),
              "exit": code, "objects": objects, "binaries": binaries}
    write_json(destination / "receipt.json", result)
    return result


def baseline():
    prepare()
    saved = SAVED / "C1/receipt.json"
    seed = REFERENCE / "dev" / DRIVER_TOOL
    if saved.exists():
        previous = json.loads(saved.read_text())
        if previous["compiler_sha256"] == file_digest(seed) and previous["exit"] == 0:
            # Recheck artifact bytes, not only a mutable cached result file.
            if previous["objects"] == inventory(SAVED / "C1/objects"):
                return previous
    result = generation("C1", seed)
    if result["exit"] or len(result["binaries"]) != len(TOOLS):
        raise RuntimeError("C++ self-build baseline failed; see bootstrap-C1.log")
    return result


def compare(expected, actual):
    return (actual["exit"] == 0 and expected["objects"] == actual["objects"]
            and expected["binaries"] == actual["binaries"])


def progress():
    expected = baseline()
    actual = generation("CR", candidate_path(DRIVER_TOOL))
    print(f"===== {BOOTSTRAP_STAGE} =====")
    for category in ("objects", "binaries"):
        for name, wanted in expected[category].items():
            passed = actual[category].get(name) == wanted
            verdict = "PASS (1/1)" if passed else "FAIL (0/1)"
            print(f"clone/{BOOTSTRAP_STAGE}/{category}/{name}: {verdict}")
    complete = compare(expected, actual)
    print(f"clone/{BOOTSTRAP_STAGE}/complete-inventory: " + ("PASS (1/1)" if complete else "FAIL (0/1)"))
    return complete


def rebuilt_bindings(stage):
    primary = primary_tool(stage)
    binary = lambda tool: str(BINS / (tool + "-self"))
    return ["CPPGM_SKIP_DEV_REBUILD=1", "TEST_DEPS=", "CPPGM_TEST_RUNNER=1",
            "CXX=/usr/bin/g++", "CPPGM_HOST_CXX=/usr/bin/g++",
            "CPPGM_TEST_APP=" + binary(primary), "CPPGM_DRIVER_APP=" + binary(DRIVER_TOOL),
            "LOWIROPT_APP=" + binary("lowiropt"), "LOWIR2NATIVE_APP=" + binary("lowir2native"),
            "NATIVE_REFERENCE_APP=" + binary("lowir2native"),
            "CPPGM_LOWIR_BEHAVIOR_APP=" + binary("lowir2native"),
            "CPPGM_CPPGM_APP=" + binary(DRIVER_TOOL),
            "CPPGM_LOWIROPT_APP=" + binary("lowiropt"),
            "CPPGM_LOWIR2NATIVE_APP=" + binary("lowir2native")]


def rebuilt_suites():
    # Run every course/debug lane with rebuilt helpers as well as its primary
    # tool. Honor keep-going markers instead of trusting make's final status.
    for stage, target in [(n, "test") for n in correctness_numbers()] + [
            (n, "test-debuginfo") for n in [int(stage[2:]) for stage in DEBUG_STAGES]]:
        passed = run_course(["make", "--no-print-directory", "-s", target,
                             *rebuilt_bindings(stage)], cwd=WORK / f"pa{stage}",
                            artifacts=ARTIFACTS / "bootstrap-rebuilt" / f"pa{stage}" / target)
        if not passed:
            return False
    return True


def final():
    # PA34 fixes can regress Rust debug behavior or the ownership census after
    # PA33 was accepted. Re-run those release requirements on the final R.
    code, out, err = run([sys.executable, str(CONTROL / "clone_check.py"), "release", BOOTSTRAP_STAGE],
                         timeout=14400)
    (ARTIFACTS / "bootstrap-rust-release.log").write_bytes(out + err)
    if code:
        return False
    # A release proof rebuilds C1 too; cached objects cannot establish it.
    prepare()
    first = generation("C1", REFERENCE / "dev" / DRIVER_TOOL)
    if first["exit"]:
        return False
    second = generation("C2", SAVED / "C1/bin" / (DRIVER_TOOL + "-self"))
    candidate = generation("CR", candidate_path(DRIVER_TOOL))
    if not compare(first, second) or not compare(first, candidate):
        return False
    third = generation("C3", SAVED / "CR/bin" / (DRIVER_TOOL + "-self"))
    if not compare(first, third):
        return False
    if not rebuilt_suites():
        return False
    print("C1 == C2 == CR == C3: all objects, all nine tools, rebuilt configured course/debug suites")
    return True


if __name__ == "__main__":
    try:
        sys.exit(0 if (final() if "--final" in sys.argv else progress()) else 1)
    except (RuntimeError, OSError, ValueError) as error:
        print("bootstrap infrastructure error:", error, file=sys.stderr)
        sys.exit(2)
