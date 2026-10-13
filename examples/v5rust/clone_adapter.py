#!/usr/bin/env python3
"""Test-only batch transport and raw invocation comparator; never production."""
import json
import os
from pathlib import Path
import re
import resource
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
            if line.startswith(b"abimangle stats: "):
                line = re.sub(rb"\b(peak_graph_bytes)=([0-9]+)(?=\s|$)",
                              rb"\1=<measurement>", line)
        rows.append(line)
    return b"".join(rows)


def invocation_differences(expected, actual, expected_files, actual_files):
    differences = []
    for label, wanted, got in zip(("exit", "stdout", "stderr"), expected, actual):
        if label == "stderr":
            wanted, got = comparable_stderr(wanted), comparable_stderr(got)
        if wanted != got:
            differences.append(label)
    for label, result in (("abnormal-or-incomplete", actual), ("oracle-infrastructure", expected)):
        if result[0] < 0 or result[0] in (70, 86, 124, 125, 101):
            differences.append(label)
    differences.extend(name for name in expected_files if expected_files[name] != actual_files[name])
    return differences


def stack_exhausted(tool, result):
    if tool != "cppgm++" or result[0] != 1 or result[1]:
        return False
    diagnostic = b"\n".join(line for line in result[2].splitlines() if not is_stats_line(line))
    return re.fullmatch(rb"ERROR: [^\n]+:[0-9]+:[0-9]+: constructs nested too deeply", diagnostic) is not None


def qualify_stack(tool, arguments, data, env, timeout, executable, initial, outputs, before, keep):
    """Prove exact successful behavior, rather than normalize a guard failure."""
    exhausted = [stack_exhausted(tool, result) for result in initial]
    if not any(exhausted) or any(not guard and result[0] != 0 for guard, result in zip(exhausted, initial)):
        return None
    soft, hard = resource.getrlimit(resource.RLIMIT_STACK)
    maximum = min(64 << 20, hard) if hard != resource.RLIM_INFINITY else 64 << 20
    proof = {"passed": False, "initial_stack_bytes": soft, "attempts": []}
    evidence = Path(os.environ["V5RUST_TRACE"]).parent / "stack-qualifications" / uuid.uuid4().hex
    evidence.mkdir(parents=True)
    proof["evidence"] = str(evidence)
    for label, result in zip(("oracle", "candidate"), initial):
        (evidence / (label + ".initial.stdout")).write_bytes(result[1])
        (evidence / (label + ".initial.stderr")).write_bytes(result[2])
    limit = max(16 << 20, soft * 2) if soft != resource.RLIM_INFINITY else maximum + 1
    try:
        while limit <= maximum:
            results, files = [], []
            attempt_dir = evidence / str(limit)
            attempt_dir.mkdir()
            for label, binary in (("oracle", REFERENCE / "dev" / tool), ("candidate", executable)):
                restore(before)
                result = run([str(binary), *arguments], cwd=Path.cwd(), env=env,
                             stdin=data, timeout=timeout, stack_limit_bytes=limit)
                contents = snapshot(outputs)
                results.append(result)
                files.append(contents)
                (attempt_dir / (label + ".stdout")).write_bytes(result[1])
                (attempt_dir / (label + ".stderr")).write_bytes(result[2])
                for index, value in enumerate(contents.values()):
                    if value is not None:
                        (attempt_dir / f"output-{index}.{label}").write_bytes(value)
            differences = invocation_differences(*results, *files)
            proof["attempts"].append({"stack_bytes": limit, "exits": [r[0] for r in results],
                                      "differences": differences, "output_order": list(files[0]),
                                      "outputs": [{name: digest(value) if value is not None else None
                                                   for name, value in contents.items()} for contents in files]})
            if all(r[0] == 0 for r in results):
                proof["passed"] = not differences
                break
            if not any(stack_exhausted(tool, r) for r in results) or any(
                    r[0] != 0 and not stack_exhausted(tool, r) for r in results):
                break
            limit *= 2
    finally:
        # Course callers still receive the candidate's original result/files;
        # qualification never substitutes oracle output or waives their checks.
        restore(keep)
    return proof


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
    differences = invocation_differences(expected, actual, expected_files, actual_files)
    initial_differences = list(differences)
    qualification = qualify_stack(tool, arguments, data, env, timeout, executable,
                                  (expected, actual), outputs, before, actual_files)
    if qualification is not None:
        differences = [] if qualification["passed"] else [*differences, "stack-qualification-failed"]
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
    if qualification is not None:
        record["initial_differences"] = initial_differences
        record["stack_qualification"] = qualification
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
