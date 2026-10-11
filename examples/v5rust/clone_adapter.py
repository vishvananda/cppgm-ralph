#!/usr/bin/env python3
"""Test-only batch transport and raw invocation comparator; never production."""
import json
import os
from pathlib import Path
import re
import sys
import uuid

from clone_common import REFERENCE, candidate_path, digest, run


def output_paths(tool, arguments):
    paths = []
    for index, argument in enumerate(arguments):
        if argument in ("-o", "-MF", "--dump-machine-ir", "--map", "--link-map"):
            if index + 1 < len(arguments) and arguments[index + 1] != "-":
                paths.append(Path(arguments[index + 1]))
        elif argument.startswith(("--verify-dump=", "--dump-machine-ir=")):
            paths.append(Path(argument.split("=", 1)[1]))
    if tool == "cppgm++" and "-o" not in arguments:
        sources = [Path(arg) for arg in arguments if not arg.startswith("-")
                   and Path(arg).suffix in (".cpp", ".cc", ".cxx", ".t")]
        if "-c" in arguments:
            paths.extend(Path(source.stem + ".o") for source in sources)
        elif sources and not any(arg.startswith(("-E", "--emit-", "-dump")) for arg in arguments):
            paths.append(Path("a.out"))
    return list(dict.fromkeys(paths))


def snapshot(paths):
    return {str(path): path.read_bytes() if path.is_file() else None for path in paths}


def restore(contents):
    for name, data in contents.items():
        path = Path(name)
        if data is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(data)


def append_receipt(record):
    trace = os.environ.get("V5RUST_TRACE")
    if not trace:
        raise RuntimeError("differential adapter requires a trace path")
    encoded = (json.dumps(record, sort_keys=True) + "\n").encode()
    descriptor = os.open(trace, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        # A trace belongs to one case. O_APPEND also supports worker processes.
        os.write(descriptor, encoded)
    finally:
        os.close(descriptor)


def is_stats_line(line):
    return line.startswith((b"lowir2native_stats ", b"lowiropt_stats ",
                            b"preproc stats ", b"lowir stats: ", b"abimangle stats: ")) or (
        line.startswith(b"cppgm++ ") and (b" stats " in line or b" stats:" in line))


def comparable_stderr(data):
    """Keep diagnostic bytes and deterministic counters; measure runtime costs."""
    rows = []
    for line in data.splitlines(keepends=True):
        if is_stats_line(line):
            line = re.sub(rb"\b([a-z_]+_ms|peak_rss_kb|(?:(?:syntax|semantic|pp|lowir|name)_)?arena_bytes|peak_run_bytes)=([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)(?=\s|$)",
                          rb"\1=<measurement>", line)
        rows.append(line)
    return b"".join(rows)


def compare_invocation(tool, arguments, data, extra_env):
    env = dict(os.environ)
    env.update(extra_env)
    env.pop("WRAPPED_BATCH_STDIN", None)
    timeout = max(1, int(extra_env.get("CPPGM_BATCH_TIMEOUT_SEC", "120")))
    outputs = output_paths(tool, arguments)
    before = snapshot(outputs)
    expected = run([str(REFERENCE / "dev" / tool), *arguments], cwd=Path.cwd(),
                   env=env, stdin=data, timeout=timeout)
    expected_files = snapshot(outputs)
    restore(before)
    executable = candidate_path(tool)
    if os.environ.get("V5RUST_ORACLE_SELF_CHECK") == "1":
        executable = REFERENCE / "dev" / tool
    actual = run([str(executable), *arguments], cwd=Path.cwd(), env=env,
                 stdin=data, timeout=timeout)
    actual_files = snapshot(outputs)
    differences = []
    for label, wanted, got in zip(("exit", "stdout", "stderr"), expected, actual):
        if label == "stderr":
            wanted, got = comparable_stderr(wanted), comparable_stderr(got)
        if wanted != got:
            differences.append(label)
    if actual[0] < 0 or actual[0] in (70, 86, 124, 125, 101):
        differences.append("abnormal-or-incomplete")
    if expected[0] < 0 or expected[0] in (70, 86, 124, 125, 101):
        differences.append("oracle-infrastructure")
    for name in expected_files:
        if expected_files[name] != actual_files[name]:
            differences.append(name)
    record = {"tool": tool, "arguments": arguments, "candidate": str(executable),
              "exit": actual[0], "oracle_exit": expected[0],
              "match": not differences, "differences": differences,
              "stdout_sha256": digest(actual[1]), "stderr_sha256": digest(actual[2]),
              "outputs": {name: digest(value) if value is not None else None
                          for name, value in actual_files.items()}}
    record["oracle_outputs"] = {name: digest(value) if value is not None else None
                                for name, value in expected_files.items()}
    record["statistics"] = {
        "oracle": [line.decode(errors="replace") for line in expected[2].splitlines() if is_stats_line(line)],
        "candidate": [line.decode(errors="replace") for line in actual[2].splitlines() if is_stats_line(line)]}
    if differences:
        record["expected_stderr"] = expected[2][-4000:].decode(errors="replace")
        record["actual_stderr"] = actual[2][-4000:].decode(errors="replace")
        evidence = Path(os.environ["V5RUST_TRACE"]).parent / "mismatches" / uuid.uuid4().hex
        evidence.mkdir(parents=True)
        for label, result in (("oracle", expected), ("candidate", actual)):
            (evidence / (label + ".stdout")).write_bytes(result[1])
            (evidence / (label + ".stderr")).write_bytes(result[2])
        for index, name in enumerate(expected_files):
            for label, values in (("oracle", expected_files), ("candidate", actual_files)):
                if values[name] is not None:
                    (evidence / f"output-{index}.{label}").write_bytes(values[name])
        record["evidence"] = str(evidence)
        record["output_order"] = list(expected_files)
    append_receipt(record)
    # The assignment receives only candidate results. The outer checker rejects
    # any mismatching invocation, even when a loose negative test would pass.
    return actual


def batch(tool, arguments):
    for line in sys.stdin.buffer:
        fields = line.rstrip(b"\r\n").decode().split("\t")
        if len(fields) < 4:
            raise ValueError("malformed wrapped batch request")
        stdout, stderr, input_path, environment, *case_args = fields
        extra_env = dict(item.split("=", 1) for item in environment.split(";") if item)
        data = Path(input_path).read_bytes() if input_path != "-" else b""
        code, out, err = compare_invocation(tool, [*arguments, *case_args], data, extra_env)
        with open(stdout, "ab") as stream:
            stream.write(out)
            if stderr == stdout:
                stream.write(err)
        if stderr != stdout:
            with open(stderr, "ab") as stream:
                stream.write(err)
        status = {0: "EXIT_SUCCESS", 86: "EXIT_NOT_IMPLEMENTED", 124: "EXIT_TIMEOUT",
                  125: "EXIT_OOM"}.get(code, str(code if code >= 0 else 128 - code))
        print(status, flush=True)


def main():
    tool, *arguments = sys.argv[1:]
    if "--batch-stdin" in arguments:
        arguments.remove("--batch-stdin")
        batch(tool, arguments)
        return 0
    code, out, err = compare_invocation(tool, arguments, sys.stdin.buffer.read(), {})
    sys.stdout.buffer.write(out)
    sys.stderr.buffer.write(err)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main())
