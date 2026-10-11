#!/usr/bin/env python3
"""PA34: replay the original Makefile at identical paths for every generation."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import sys

from clone_common import ARTIFACTS, REFERENCE, ROOT, TOOLS, candidate_path, file_digest, run, write_json

BASE = ROOT / "obj/bootstrap"
WORK = BASE / "work"
OBJECTS = WORK / "obj/pa34/selfhost"
BINS = WORK / "obj/pa34/bin/selfhost"
SAVED = BASE / "generations"


def prepare():
    (WORK / "pa34").mkdir(parents=True, exist_ok=True)
    for name in ("dev", "scripts", "shared"):
        target = WORK / name
        if not target.exists():
            target.symlink_to(REFERENCE / name, target_is_directory=True)
    shutil.copyfile(REFERENCE / "pa34/Makefile", WORK / "pa34/Makefile")
    for number in range(1, 34):
        target = WORK / f"pa{number}"
        if not target.exists():
            shutil.copytree(REFERENCE / f"pa{number}", target,
                            ignore=shutil.ignore_patterns("*.my*", "*.check*", ".test_failed"))
    SAVED.mkdir(parents=True, exist_ok=True)


def recipe(compiler, target="all"):
    return ["make", "--no-print-directory", "-k", "-j1", "-C", str(WORK / "pa34"), target,
            "CXX=" + str(compiler), "CPPGM_HOST_CXX=/usr/bin/g++",
            "INCEPTION_COMPILER_FLAVOR=selfhost", "INCEPTION_COMPARE_OBJECTS=0",
            "INCEPTION_BUILD_MISSING_FIRST=0", "INCEPTION_BUILD_JOBS=8",
            "INCEPTION_OBJECT_BUILD_JOBS=8", "INCEPTION_SELFHOST_OPT_LEVEL=3",
            "INCEPTION_OBJ_ROOT_BASE=../obj/pa34", "CPPGM_TEST_RUNNER=1"]


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
    seed = REFERENCE / "dev/cppgm++"
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
    actual = generation("CR", candidate_path("cppgm++"))
    print("===== pa34 =====")
    for category in ("objects", "binaries"):
        for name, wanted in expected[category].items():
            passed = actual[category].get(name) == wanted
            verdict = "PASS (1/1)" if passed else "FAIL (0/1)"
            print(f"clone/pa34/{category}/{name}: {verdict}")
    complete = compare(expected, actual)
    print("clone/pa34/complete-inventory: " + ("PASS (1/1)" if complete else "FAIL (0/1)"))
    return complete


def final():
    # A release proof rebuilds C1 too; cached objects cannot establish it.
    prepare()
    first = generation("C1", REFERENCE / "dev/cppgm++")
    if first["exit"]:
        return False
    second = generation("C2", SAVED / "C1/bin/cppgm++-self")
    candidate = generation("CR", candidate_path("cppgm++"))
    if not compare(first, second) or not compare(first, candidate):
        return False
    third = generation("C3", SAVED / "CR/bin/cppgm++-self")
    if not compare(first, third):
        return False
    # Exercise the actual rebuilt C++ tools using PA34's owning recipes. These
    # targets do not rebuild; BINS currently contains the C3 generation.
    for number in range(1, 34):
        code, out, err = run(recipe(SAVED / "CR/bin/cppgm++-self",
                                   f"test-pa{number}-nobuild"), timeout=3600)
        (ARTIFACTS / f"bootstrap-rebuilt-pa{number}.log").write_bytes(out + err)
        if code:
            return False
    print("C1 == C2 == CR == C3: all objects, all nine tools, rebuilt PA1-PA33")
    return True


if __name__ == "__main__":
    try:
        sys.exit(0 if (final() if "--final" in sys.argv else progress()) else 1)
    except (RuntimeError, OSError, ValueError) as error:
        print("bootstrap infrastructure error:", error, file=sys.stderr)
        sys.exit(2)
