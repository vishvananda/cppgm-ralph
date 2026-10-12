"""Tests for guarantees on which automatic progression depends."""
import contextlib
import io
import json
import resource
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import clone_adapter
import clone_bootstrap
import clone_check
import clone_common
import rust_audit


class RustAuditTests(unittest.TestCase):
    def inspect(self, source, name="dev/src/sema/example.rs"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / name
            file.parent.mkdir(parents=True)
            file.write_text(source)
            return rust_audit.inspect_file(file, root, {})[0]

    def test_nested_comments_and_raw_strings_do_not_create_functions(self):
        text = '/* outer /* fn hidden() { */ inner */\nfn visible() {\n let _s = r###"fn fake() { }"###;\n}\n'
        self.assertEqual(self.inspect(text), [])

    def test_function_limit_counts_code_and_excludes_comments(self):
        self.assertEqual(self.inspect("fn f() {\n" + "// comment\n" * 300 + "}\n"), [])
        findings = self.inspect("fn f() {\n" + "let _x = 1;\n" * 239 + "}\n")
        self.assertTrue(any("241 code lines" in item for item in findings))

    def test_phase_environment_import_and_alias_are_rejected(self):
        self.assertTrue(self.inspect("use std::env as settings;\n"))
        self.assertTrue(self.inspect('fn f() { let _ = option_env!("HOME"); }\n'))
        self.assertTrue(self.inspect("use std::{env as settings};\n"))
        self.assertTrue(self.inspect("use std::env;\n", "dev/src/driver/options.rs"))

    def test_backend_does_not_depend_on_parser_or_sema(self):
        self.assertTrue(self.inspect("use crate::sema::Facts;\n", "dev/src/native/select.rs"))
        self.assertTrue(self.inspect("use crate::{syntax::Tree};\n", "dev/src/opt/fold.rs"))
        self.assertEqual(self.inspect("use crate::lowir::Program;\n", "dev/src/native/select.rs"), [])

    def test_unsafe_and_mechanical_fragments_are_rejected(self):
        self.assertTrue(self.inspect("fn f() { unsafe {} }\n"))
        self.assertTrue(self.inspect("fn f() {}\n", "dev/src/sema/part1.rs"))

    def test_nested_function_and_closure_are_audited(self):
        text = "fn f() { let _c = || {\n" + "let _x = 1;\n" * 241 + "}; }\n"
        self.assertTrue(any("function/closure" in item for item in self.inspect(text)))

    def test_dispatch_extension_requires_real_match_arms(self):
        ordinary = "fn f() {\n" + "let _x = 1;\n" * 250 + "}\n"
        self.assertTrue(self.inspect(ordinary))
        dispatch = "fn f() {\nmatch 0 {\n" + "".join(f"{i} => {{\n" + "let _x = 1;\n" * 30 + "},\n" for i in range(8)) + "_ => {}\n}\n}\n"
        self.assertEqual(self.inspect(dispatch), [])


class ComparisonTests(unittest.TestCase):
    def compare_stack(self, outcomes, arguments=(), runner=None):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / "trace.jsonl"
            with patch.dict("os.environ", {"V5RUST_TRACE": str(trace)}), \
                    patch.object(clone_adapter.resource, "getrlimit", return_value=(8 << 20, resource.RLIM_INFINITY)), \
                    patch.object(clone_adapter, "run", side_effect=runner or outcomes) as run:
                result = clone_adapter.compare_invocation("cppgm++", list(arguments), b"input", {})
            return result, json.loads(trace.read_text()), run.call_args_list

    def test_stack_cutoff_difference_requires_successful_exact_retry(self):
        left = (1, b"", b"ERROR: input.cpp:1:100: constructs nested too deeply\n")
        right = (1, b"", b"ERROR: input.cpp:1:200: constructs nested too deeply\n")
        result, receipt, calls = self.compare_stack([left, right, (0, b"tree", b""), (0, b"tree", b"")])
        self.assertEqual(result, right)
        self.assertTrue(receipt["match"])
        self.assertEqual(receipt["initial_differences"], ["stderr"])
        self.assertTrue(receipt["stack_qualification"]["passed"])
        self.assertEqual([c.kwargs.get("stack_limit_bytes") for c in calls], [None, None, 16 << 20, 16 << 20])

    def test_one_sided_guard_can_qualify_but_original_candidate_bytes_remain(self):
        guard = (1, b"", b"ERROR: input.cpp:1:100: constructs nested too deeply\n")
        success = (0, b"tree", b"")
        for left, right in ((guard, success), (success, guard)):
            with self.subTest(left=left):
                result, receipt, _ = self.compare_stack([left, right, success, success])
                self.assertTrue(receipt["match"])
                self.assertEqual(result, right)

    def test_normal_rejections_and_abnormal_exits_do_not_qualify(self):
        guard = (1, b"", b"ERROR: input.cpp:1:100: constructs nested too deeply\n")
        for result in [(1, b"", b"ERROR: input.cpp:1:100: syntax error\n"),
                       (1, b"", b"ERROR: input.cpp:1:100: syntax error; constructs nested too deeply\n"),
                       *[(code, b"", guard[2]) for code in (-6, 70, 86, 101, 124, 125)]]:
            with self.subTest(result=result):
                _, receipt, calls = self.compare_stack([guard, result])
                self.assertFalse(receipt["match"])
                self.assertNotIn("stack_qualification", receipt)
                self.assertEqual(len(calls), 2)

    def test_elevated_success_still_requires_stream_counter_and_artifact_equality(self):
        guard = (1, b"", b"ERROR: input.cpp:1:100: constructs nested too deeply\n")
        for actual in [(0, b"wrong", b""), (0, b"tree", b"wrong\n"),
                       (0, b"tree", b"cppgm++ stats input.cpp: tokens=2\n"),
                       (1, b"", b"syntax error\n"), (101, b"", b"panic\n"),
                       (124, b"", b"timeout\n"), (-11, b"", b"signal\n")]:
            with self.subTest(actual=actual):
                _, receipt, calls = self.compare_stack([guard, guard, (0, b"tree", b""), actual])
                self.assertFalse(receipt["match"])
                self.assertIn("stack-qualification-failed", receipt["differences"])
                self.assertEqual(len(calls), 4)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "tree.ast"
            output.write_bytes(b"before")
            values = [b"original-oracle", b"original-candidate", b"higher-oracle", b"higher-wrong"]
            def run(*args, **kwargs):
                self.assertEqual(output.read_bytes(), b"before")
                output.write_bytes(values.pop(0))
                return guard if len(values) >= 2 else (0, b"", b"")
            _, receipt, _ = self.compare_stack([], ["-o", str(output)], runner=run)
            self.assertFalse(receipt["match"])
            self.assertEqual(output.read_bytes(), b"original-candidate")

    def test_persistent_guard_is_bounded_and_fails_even_when_original_bytes_match(self):
        guard = (1, b"", b"ERROR: input.cpp:1:100: constructs nested too deeply\n")
        _, receipt, calls = self.compare_stack([guard] * 8)
        self.assertFalse(receipt["match"])
        self.assertEqual([c.kwargs["stack_limit_bytes"] for c in calls[2:]],
                         [16 << 20, 16 << 20, 32 << 20, 32 << 20, 64 << 20, 64 << 20])

    def test_qualified_artifacts_and_evidence_preserve_original_candidate_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "tree.ast"
            trace = Path(directory) / "trace.jsonl"
            output.write_bytes(b"before")
            values = [b"guard-oracle", b"guard-candidate", b"same", b"same"]
            guard = (1, b"", b"ERROR: input.cpp:1:100: constructs nested too deeply\n")
            def run(*args, **kwargs):
                self.assertEqual(output.read_bytes(), b"before")
                output.write_bytes(values.pop(0))
                return guard if len(values) >= 2 else (0, b"", b"")
            with patch.dict("os.environ", {"V5RUST_TRACE": str(trace)}), \
                    patch.object(clone_adapter.resource, "getrlimit", return_value=(8 << 20, resource.RLIM_INFINITY)), \
                    patch.object(clone_adapter, "run", side_effect=run):
                result = clone_adapter.compare_invocation("cppgm++", ["-o", str(output)], b"", {})
            receipt = json.loads(trace.read_text())
            self.assertTrue(receipt["match"])
            self.assertEqual(result, guard)
            self.assertEqual(output.read_bytes(), b"guard-candidate")
            evidence = Path(receipt["stack_qualification"]["evidence"])
            self.assertEqual((evidence / "candidate.initial.stderr").read_bytes(), guard[2])
            self.assertEqual((evidence / str(16 << 20) / "output-0.candidate").read_bytes(), b"same")

    def test_hard_stack_limit_prevents_unavailable_qualification(self):
        guard = (1, b"", b"ERROR: input.cpp:1:100: constructs nested too deeply\n")
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / "trace.jsonl"
            with patch.dict("os.environ", {"V5RUST_TRACE": str(trace)}), \
                    patch.object(clone_adapter.resource, "getrlimit", return_value=(8 << 20, 8 << 20)), \
                    patch.object(clone_adapter, "run", side_effect=[guard, guard]) as run:
                clone_adapter.compare_invocation("cppgm++", [], b"", {})
            receipt = json.loads(trace.read_text())
            self.assertFalse(receipt["match"])
            self.assertEqual(receipt["stack_qualification"]["attempts"], [])
            self.assertEqual(run.call_count, 2)

    def test_child_stack_limit_does_not_change_parent_limit(self):
        before = resource.getrlimit(resource.RLIMIT_STACK)
        # This is a subprocess unit test, independent of local run settings.
        # In CI the configured checkout/reference paths need not exist.
        with tempfile.TemporaryDirectory() as directory:
            result = clone_common.run([sys.executable, "-c",
                                      "import resource;print(resource.getrlimit(resource.RLIMIT_STACK)[0])"],
                                     cwd=Path(directory), stack_limit_bytes=before[0])
        self.assertEqual(result[0], 0)
        self.assertEqual(int(result[1]), before[0])
        self.assertEqual(resource.getrlimit(resource.RLIMIT_STACK), before)

    def test_only_runtime_measurements_are_excluded_from_stats(self):
        left = b"lowir2native_stats code_bytes=19 select_ms=0.1 peak_rss_kb=100\n"
        right = b"lowir2native_stats code_bytes=19 select_ms=0.9 peak_rss_kb=200\n"
        self.assertEqual(clone_adapter.comparable_stderr(left), clone_adapter.comparable_stderr(right))
        self.assertNotEqual(clone_adapter.comparable_stderr(left), clone_adapter.comparable_stderr(right.replace(b"=19", b"=20")))
        self.assertEqual(clone_adapter.comparable_stderr(b"ERROR select_ms=0.1\n"), b"ERROR select_ms=0.1\n")

    def test_complete_bytes_exit_and_stderr_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / "trace.jsonl"
            with patch.dict("os.environ", {"V5RUST_TRACE": str(trace)}):
                with patch.object(clone_adapter, "run", side_effect=[(1, b"", b"reject\n"), (1, b"", b"wrong\n")]):
                    clone_adapter.compare_invocation("pptoken", [], b"bad", {})
            result = json.loads(trace.read_text())
            self.assertFalse(result["match"])
            self.assertEqual(result["differences"], ["stderr"])

    def test_standalone_stats_exclude_storage_but_preserve_work_and_names(self):
        for prefix, storage in [(b"preproc stats primary.cpp: ", b"arena_bytes"),
                                (b"lowir stats: ", b"name_arena_bytes"),
                                (b"abimangle stats: ", b"arena_bytes")]:
            with self.subTest(prefix=prefix):
                left = prefix + b"source_bytes=223 " + storage + b"=16384 parse_ms=0.1 peak_rss_kb=100\n"
                right = prefix + b"source_bytes=223 " + storage + b"=0 parse_ms=0.9 peak_rss_kb=200\n"
                normalized = clone_adapter.comparable_stderr(left)
                self.assertEqual(normalized, clone_adapter.comparable_stderr(right))
                for before, after in [(b"source_bytes=223", b"source_bytes=224"),
                                      (storage, b"other_storage"), (prefix, b"ERROR ")]:
                    self.assertNotEqual(normalized, clone_adapter.comparable_stderr(right.replace(before, after)))

    def test_storage_measurements_in_diagnostics_remain_exact(self):
        for line in [b"ERROR arena_bytes=16384\n", b"preproc error: arena_bytes=16384\n",
                     b"unknown stats: arena_bytes=16384\n"]:
            self.assertEqual(clone_adapter.comparable_stderr(line), line)

    def test_preproc_stats_receipt_retains_raw_storage_when_comparison_passes(self):
        expected = b"preproc stats primary.cpp: source_tokens=24 arena_bytes=16384\n"
        actual = b"preproc stats primary.cpp: source_tokens=24 arena_bytes=0\n"
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / "trace.jsonl"
            with patch.dict("os.environ", {"V5RUST_TRACE": str(trace)}):
                with patch.object(clone_adapter, "run", side_effect=[(0, b"tokens", expected), (0, b"tokens", actual)]):
                    result = clone_adapter.compare_invocation("preproc", [], b"", {})
            receipt = json.loads(trace.read_text())
            self.assertTrue(receipt["match"])
            self.assertEqual(receipt["differences"], [])
            self.assertEqual(receipt["statistics"], {
                "oracle": [expected.decode().strip()], "candidate": [actual.decode().strip()]})
            self.assertEqual(result[2], actual)

    def test_unimplemented_does_not_match_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / "trace.jsonl"
            with patch.dict("os.environ", {"V5RUST_TRACE": str(trace)}):
                with patch.object(clone_adapter, "run", side_effect=[(1, b"", b""), (86, b"", b"")]):
                    clone_adapter.compare_invocation("pptoken", [], b"", {})
            self.assertIn("abnormal-or-incomplete", json.loads(trace.read_text())["differences"])

    def test_original_output_is_restored_before_candidate_and_candidate_is_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "test.o"
            output.write_bytes(b"original")
            trace = Path(directory) / "trace.jsonl"
            calls = []
            def compile_stub(*_args, **_kwargs):
                self.assertEqual(output.read_bytes(), b"original")
                value = b"oracle" if not calls else b"candidate"
                output.write_bytes(value)
                calls.append(value)
                return 0, b"", b""
            with patch.dict("os.environ", {"V5RUST_TRACE": str(trace)}):
                with patch.object(clone_adapter, "run", side_effect=compile_stub):
                    clone_adapter.compare_invocation("cppgm++", ["-o", str(output)], b"", {})
            self.assertEqual(output.read_bytes(), b"candidate")
            self.assertFalse(json.loads(trace.read_text())["match"])

    def test_identity_swap_fails_even_with_equal_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "state.json").write_text(json.dumps({"lastTestStatus": {"stages": [{
                "name": "pa1", "targets": [{"name": "clone/pa1/a", "status": "pass"}]}]}}))
            (root / "last-test.log").write_text("clone/pa1/b: PASS (1/1)\nclone/pa1/a: FAIL (0/1)\n")
            with patch.dict(clone_check.SETTINGS, {"state_dir": directory}), contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(clone_check.preserve("pa1"))

    def test_bootstrap_requires_object_inventory_and_all_tool_hashes(self):
        original = {"exit": 0, "objects": {"a.o": "x"}, "binaries": {"cppgm++": "y"}}
        self.assertTrue(clone_bootstrap.compare(original, dict(original)))
        self.assertFalse(clone_bootstrap.compare(original, {**original, "objects": {"a.o": "x", "extra.o": "z"}}))
        self.assertFalse(clone_bootstrap.compare(original, {**original, "binaries": {"cppgm++": "different"}}))

    def test_matching_compiler_bytes_do_not_excuse_course_checker_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            def check_stub(*_args, **kwargs):
                self.assertEqual(kwargs["env"]["KEEP_GOING"], "0")
                trace = Path(kwargs["env"]["V5RUST_TRACE"])
                trace.write_text((json.dumps({"match": True}) + "\n") * 4)
                return 2, b"", b"native O2 lost a post-call direct field load\n"
            with patch.object(clone_check, "ARTIFACTS", Path(directory)):
                with patch.object(clone_check, "run", side_effect=check_stub):
                    result = clone_check.execute_case(
                        "pa33", "tests/regression/controls/459-parameter-address-folding.t")
            self.assertFalse(result["passed"])
            self.assertEqual(result["course_exit"], 2)

    def test_course_honors_failure_markers_and_counts_even_with_exit_zero(self):
        for code, marker, counts, expected in [
            (0, False, "2 2\n3 3\n", True), (0, True, "2 2\n", False),
            (0, False, "1 2\n", False), (0, False, "invalid\n", False),
            (1, False, "2 2\n", False),
        ]:
            with self.subTest(code=code, marker=marker, counts=counts), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                # A stale failure must not poison a later successful run.
                (root / ".test_failed").touch()
                def course_stub(*_args, **kwargs):
                    self.assertFalse((root / ".test_failed").exists())
                    if marker:
                        (root / ".test_failed").touch()
                    Path(kwargs["env"]["CPPGM_TEST_COUNTS_FILE"]).write_text(counts)
                    return code, b"course output\n", b""
                with patch.object(clone_common, "run", side_effect=course_stub):
                    self.assertEqual(clone_common.run_course(
                        ["make", "test"], cwd=root, artifacts=root / "evidence"), expected)

    def test_rebuilt_suites_include_debug_and_bind_all_helpers_to_rebuilt_tools(self):
        with patch.object(clone_bootstrap, "run_course", return_value=True) as check:
            self.assertTrue(clone_bootstrap.rebuilt_suites())
        self.assertEqual(check.call_count, 36)
        debug_stages = []
        for call in check.call_args_list:
            command = call.args[0]
            if "test-debuginfo" in command:
                debug_stages.append(call.kwargs["cwd"].name)
            for variable, tool in [("CPPGM_CPPGM_APP", "cppgm++"),
                                   ("CPPGM_LOWIROPT_APP", "lowiropt"),
                                   ("CPPGM_LOWIR2NATIVE_APP", "lowir2native")]:
                self.assertIn(variable + "=" + str(clone_bootstrap.BINS / (tool + "-self")), command)
        self.assertEqual(debug_stages, ["pa8", "pa32", "pa33"])
        with patch.object(clone_bootstrap, "run_course", side_effect=[True] * 33 + [False]):
            self.assertFalse(clone_bootstrap.rebuilt_suites())

    def test_final_bootstrap_requires_current_rust_release_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(clone_bootstrap, "ARTIFACTS", Path(directory)):
                with patch.object(clone_bootstrap, "run", return_value=(1, b"", b"debug regression")) as check:
                    with patch.object(clone_bootstrap, "generation") as generation:
                        self.assertFalse(clone_bootstrap.final())
                        generation.assert_not_called()
            self.assertEqual(check.call_args.args[0][-2:], ["release", "pa34"])


if __name__ == "__main__":
    unittest.main()
