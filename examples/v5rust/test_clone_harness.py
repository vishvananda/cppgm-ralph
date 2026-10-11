"""Tests for guarantees on which automatic progression depends."""
import contextlib
import io
import json
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
