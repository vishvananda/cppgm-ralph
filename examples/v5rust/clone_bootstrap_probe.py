#!/usr/bin/env python3
"""Bounded, non-acceptance comparisons of frozen C++ compilation units."""
import argparse
import json
from pathlib import Path
import re
import shutil
import sys
import time

import clone_bootstrap as bootstrap
from clone_common import (ARTIFACTS, CONTROL, REFERENCE, TOOLS, candidate_path,
                          file_digest, run, write_json)


def prepare():
    work = bootstrap.WORK
    (work / "pa34").mkdir(parents=True, exist_ok=True)
    for name in ("dev", "scripts", "shared"):
        target = work / name
        if target.exists() or target.is_symlink():
            if target.resolve() != (REFERENCE / name).resolve():
                raise RuntimeError(f"unexpected bootstrap source path: {target}")
        else:
            target.symlink_to(REFERENCE / name, target_is_directory=True)
    shutil.copyfile(REFERENCE / "pa34/Makefile", work / "pa34/Makefile")


def sources():
    command = bootstrap.recipe(REFERENCE / "dev/cppgm++", "ralph-probe-inventory")
    command.append("--eval=ralph-probe-inventory: ; @printf 'shared %s\\n' $(INCEPTION_ALL_SHARED_SOURCES); printf 'entry %s\\n' $(CHECKPOINTS)")
    code, out, err = run(command, timeout=120)
    if code:
        raise RuntimeError("cannot read frozen bootstrap inventory: " + err.decode(errors="replace"))
    result = []
    for line in out.decode().splitlines():
        if line.startswith("shared "):
            source = line[7:]
            if not source.startswith("../dev/src/") or not source.endswith(".cpp"):
                raise RuntimeError("unexpected frozen shared source path")
            result.append(source[3:])
        elif line.startswith("entry "):
            result.append("dev/" + line[6:] + ".cpp")
    if not result or len(set(result)) != len(result):
        raise RuntimeError("empty or duplicate bootstrap source inventory")
    return result


def compile_source(source, compiler, directory, label):
    # Both compilers write the same logical paths. These are isolated probe
    # outputs, never inputs to the PA34 generations or final proof.
    probe = bootstrap.WORK / "obj/pa34/parity-probe"
    shutil.rmtree(probe, ignore_errors=True)
    command = bootstrap.recipe(compiler, "probe-self-object") + [
        "SOURCE=../" + source, "PROBE_CXX=" + str(compiler),
        "PROBE_OBJ_ROOT=../obj/pa34/parity-probe",
        "PROBE_TIMEOUT_SEC=120", "INCEPTION_OBJECT_BUILD_JOBS=1"]
    code, out, err = run(command, timeout=180)
    log = directory / (label + ".log")
    log.write_bytes(out + err)
    matches = re.findall(rb"^PROBE object: (.+)$", out, re.MULTILINE)
    object_hash = None
    if code == 0 and len(matches) == 1:
        obj = (bootstrap.WORK / "pa34" / matches[0].decode()).resolve()
        if not obj.is_relative_to(probe.resolve()):
            raise RuntimeError("probe object escaped its isolated output root")
        if obj.is_file():
            object_hash = file_digest(obj)
            shutil.copyfile(obj, directory / (label + ".o"))
    return {"exit": code, "object_sha256": object_hash, "log": str(log), "command": command}


def compare_source(source, directory):
    if not re.fullmatch(r"dev/[A-Za-z0-9_+./-]+\.cpp", source) or ".." in Path(source).parts:
        raise ValueError("expected a frozen dev/*.cpp source path")
    manifest = json.loads((CONTROL / "manifest.json").read_text())
    if source not in manifest["oracle_sources"]:
        raise ValueError("source is outside the frozen oracle inventory")
    if file_digest(REFERENCE / source) != manifest["oracle_sources"][source]:
        raise RuntimeError("frozen oracle source changed")
    directory.mkdir(parents=True, exist_ok=True)
    reference = compile_source(source, REFERENCE / "dev/cppgm++", directory, "reference")
    if reference["exit"] != 0 or reference["object_sha256"] is None:
        return {"source": source, "status": "oracle-failed", "reference": reference}
    candidate = compile_source(source, candidate_path("cppgm++"), directory, "candidate")
    matched = (candidate["exit"] == 0 and candidate["object_sha256"] == reference["object_sha256"])
    return {"source": source, "status": "match" if matched else "mismatch",
            "reference": reference, "candidate": candidate}


def diagnose(selected=(), *, limit=4, start_after=None):
    if not 1 <= limit <= 32:
        raise ValueError("probe limit must be between 1 and 32")
    prepare()
    inventory = list(selected) if selected else sources()
    if start_after is not None:
        if start_after not in inventory:
            raise ValueError("--start-after is outside the selected inventory")
        inventory = inventory[inventory.index(start_after) + 1:]
    if not inventory:
        raise ValueError("no remaining probe sources")
    directory = ARTIFACTS / "bootstrap-probes" / str(time.time_ns())
    directory.mkdir(parents=True)
    report = {"kind": "bootstrap-diagnostic", "acceptance_claim": False,
              "final_acceptance_required": True, "manifest_sha256": file_digest(CONTROL / "manifest.json"),
              "reference_sha256": file_digest(REFERENCE / "dev/cppgm++"),
              "candidate_sha256": file_digest(candidate_path("cppgm++")),
              "selected_total": len(inventory), "results": []}
    for source in inventory[:limit]:
        result = compare_source(source, directory / str(len(report["results"])))
        report["results"].append(result)
        write_json(directory / "report.json", report)
        print(f"Bootstrap diagnostic {source}: {result['status']}; {directory / 'report.json'}", flush=True)
        if result["status"] != "match":
            return 2 if result["status"] == "oracle-failed" else 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--limit", type=int, default=4)
    parser.add_argument("--start-after")
    args = parser.parse_args()
    try:
        sys.exit(diagnose(args.source, limit=args.limit, start_after=args.start_after))
    except (RuntimeError, OSError, ValueError) as error:
        print("bootstrap diagnostic error:", error, file=sys.stderr)
        sys.exit(2)
