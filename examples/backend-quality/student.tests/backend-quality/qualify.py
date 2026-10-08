#!/usr/bin/env python3
"""Check sensitivity using deliberately bloated/wrong scratch programs."""
import argparse
import json
from pathlib import Path
import tempfile

from check import CASES, ROOT, execute, object_sizes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    results, commands = [], []
    with tempfile.TemporaryDirectory(prefix="cppgm-quality-negative-") as directory:
        out = Path(directory)
        for label, compiler in [("gcc", "g++"), ("clang", "clang++")]:
            for case in CASES:
                source = ROOT / "student.tests" / f"pa{case['stage']}" / case["name"]
                consumer, kernel, obj, program = [out / name for name in
                                                 ["consumer.o", "kernel.cpp", "kernel.o", "program"]]
                execute([compiler, "-std=c++11", "-O2", "-c", str(source / "consumer.cpp"),
                         "-o", str(consumer)], commands)
                original = (source / "kernel.cpp").read_text()
                baseline = None
                for value in [0, case["values"][-1]]:
                    # Make formerly dormant functions externally required, or
                    # deliberately retain the accessor chain by compiling at O0.
                    code = original.replace("inline unsigned quality_unused_",
                                            "unsigned quality_unused_") if case["stage"] == 27 else original
                    kernel.write_text(code)
                    execute([compiler, "-std=c++11", "-O0", f"-D{case['macro']}={value}",
                             "-c", str(kernel), "-o", str(obj)], commands)
                    execute([compiler, str(consumer), str(obj), "-o", str(program)], commands)
                    execute([str(program)], commands)
                    sizes = object_sizes(obj)
                    if baseline is None:
                        baseline = sizes
                    else:
                        delta = {key: sizes[key] - baseline[key] for key in sizes}
                        if (delta["text_bytes"] <= case["text_growth"] and
                                delta["allocated_bytes"] <= case["alloc_growth"]):
                            raise RuntimeError(f"retention control did not exceed envelope: {label} {delta}")
                        results.append(dict(compiler=label, case=case["name"], growth=delta,
                                            behavior_passed=True, quality_rejected=True))
                broken = original.replace("return x + 19u;", "return x + 20u;") if case["stage"] == 27 \
                    else original.replace("return sum;", "return 0u;")
                if broken == original:
                    raise RuntimeError("fixture changed: update the explicit negative control")
                kernel.write_text(broken)
                execute([compiler, "-std=c++11", "-O2", "-c", str(kernel), "-o", str(obj)], commands)
                execute([compiler, str(consumer), str(obj), "-o", str(program)], commands)
                try:
                    execute([str(program)], commands)
                except RuntimeError:
                    results.append(dict(compiler=label, case=case["name"], behavior_rejected=True))
                else:
                    raise RuntimeError(f"wrong result passed: {label} {case['name']}")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(dict(results=results, commands=commands), indent=2) + "\n")
    print(f"PASS: {len(results)} deliberate quality/behavior failures detected")


if __name__ == "__main__":
    main()
