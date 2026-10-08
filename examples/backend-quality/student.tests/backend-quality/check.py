#!/usr/bin/env python3
"""Supplemental C++ fixture runner; no compiler-specific IR or timing oracle."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    dict(name="emission-growth", stage=27, macro="QUALITY_DORMANT",
         values=[0, 1, 2], levels=[0], text_growth=4096, alloc_growth=8192),
    dict(name="accessor-growth", stage=32, macro="QUALITY_DEPTH",
         values=[0, 8, 64], levels=[2, 3], text_growth=1024, alloc_growth=4096),
]


def execute(command, commands):
    commands.append([str(x) for x in command])
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    if result.returncode or result.stdout:
        raise RuntimeError(f"command failed or wrote unexpected stdout: {command}\n"
                           f"exit={result.returncode}\n{result.stdout}{result.stderr}")


def object_sizes(path):
    data = path.read_bytes()
    if data[:6] != b"\x7fELF\x02\x01":
        raise RuntimeError(f"expected ELF64 little-endian object: {path}")
    header = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
    if header[1] != 1 or header[2] != 62:
        raise RuntimeError(f"expected x86-64 relocatable object: {path}")
    offset, entry_size, count = header[6], header[11], header[12]
    if entry_size != 64 or not count or offset + entry_size * count > len(data):
        raise RuntimeError(f"invalid/unsupported ELF section table: {path}")
    text = allocated = 0
    for index in range(count):
        section = struct.unpack_from("<IIQQQQIIQQ", data, offset + index * entry_size)
        flags, size = section[2], section[5]
        if flags & 4:  # SHF_EXECINSTR, independent of section names/partitioning.
            text += size
        if flags & 2:  # SHF_ALLOC, including unwind data and zero-fill storage.
            allocated += size
    return dict(text_bytes=text, allocated_bytes=allocated, object_bytes=len(data))


def compiler_path(command):
    found = shutil.which(command)
    if not found:
        raise RuntimeError(f"compiler unavailable: {command}")
    return str(Path(found).resolve())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", action="append", metavar="NAME=PATH",
                        help="repeat for each candidate; default: GCC and Clang")
    parser.add_argument("--host-cxx", default="g++")
    parser.add_argument("--stage", default="pa32", choices=[f"pa{n}" for n in range(1, 35)])
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    stage = int(args.stage[2:])
    report = dict(stage=args.stage, results=[], commands=[], failures=[],
                  policy_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    cases = [case for case in CASES if stage >= case["stage"]]
    if not cases:
        report["status"] = "NOT_APPLICABLE"
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        print(f"NOT_APPLICABLE {args.stage}: controls start at PA27")
        return 0
    candidates = args.compiler or ["gcc=g++", "clang=clang++"]
    try:
        host = compiler_path(args.host_cxx)
        report["host"] = dict(path=host, sha256=hashlib.sha256(Path(host).read_bytes()).hexdigest())
        with tempfile.TemporaryDirectory(prefix="cppgm-quality-") as directory:
            out = Path(directory)
            for candidate_index, candidate in enumerate(candidates):
                name, command = candidate.split("=", 1)
                compiler = compiler_path(command)
                identity = dict(name=name, path=compiler,
                                sha256=hashlib.sha256(Path(compiler).read_bytes()).hexdigest())
                for case in cases:
                    source = ROOT / "student.tests" / f"pa{case['stage']}" / case["name"]
                    consumer = out / "consumer.o"
                    execute([host, "-std=c++11", "-O2", "-c", str(source / "consumer.cpp"),
                             "-o", str(consumer)], report["commands"])
                    levels = [0, 1, 2, 3] if case["stage"] == 27 and stage >= 32 else case["levels"]
                    for level in levels:
                        baseline = None
                        for value in case["values"]:
                            obj = out / f"{candidate_index}-{case['name']}-{level}-{value}.o"
                            program = out / "program"
                            execute([compiler, "-std=c++11", f"-O{level}", "-g0",
                                     f"-D{case['macro']}={value}", "-c", str(source / "kernel.cpp"),
                                     "-o", str(obj)], report["commands"])
                            execute([host, str(consumer), str(obj), "-o", str(program)], report["commands"])
                            execute([str(program)], report["commands"])
                            sizes = object_sizes(obj)
                            if baseline is None:
                                baseline = sizes
                            delta = {key: sizes[key] - baseline[key] for key in sizes}
                            passed = delta["text_bytes"] <= case["text_growth"] and \
                                delta["allocated_bytes"] <= case["alloc_growth"]
                            row = dict(compiler=identity, case=case["name"], level=level, value=value,
                                       sizes=sizes, growth=delta, passed=passed,
                                       limits=dict(text_growth=case["text_growth"],
                                                   alloc_growth=case["alloc_growth"]),
                                       source_sha256={p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                                      for p in sorted(source.glob("*.cpp"))})
                            report["results"].append(row)
                            summary = (f"{name} {case['name']} O{level} {value}: "
                                       f"text={sizes['text_bytes']} (+{delta['text_bytes']}), "
                                       f"allocated={sizes['allocated_bytes']} (+{delta['allocated_bytes']})")
                            print(("PASS " if passed else "FAIL ") + summary)
                            if not passed:
                                report["failures"].append(summary)
    except (OSError, ValueError, RuntimeError, struct.error, subprocess.TimeoutExpired) as error:
        report["failures"].append(str(error))
        print(f"ERROR {error}")
    report["status"] = "FAIL" if report["failures"] else ("PASS" if report["results"] else "NOT_APPLICABLE")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    return int(bool(report["failures"]))


if __name__ == "__main__":
    raise SystemExit(main())
