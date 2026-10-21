"""Regression tests for baseline updates across changed Git symlink modes."""
from pathlib import Path
import tempfile
import unittest

from baseline_files import install_blob, verify_blob


class BaselineFileTests(unittest.TestCase):
    def test_retarget_link_keeps_old_target_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "old").write_bytes(b"old fixture")
            (root / "new").write_bytes(b"new fixture")
            link = root / "alias"
            link.symlink_to("old")
            install_blob(link, "120000", b"new")
            verify_blob(link, "120000", b"new")
            self.assertEqual(link.read_bytes(), b"new fixture")
            self.assertEqual((root / "old").read_bytes(), b"old fixture")

    def test_file_replaces_dangling_link_without_creating_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "alias"
            path.symlink_to("missing")
            install_blob(path, "100755", b"#!/bin/sh\n")
            verify_blob(path, "100755", b"#!/bin/sh\n")
            self.assertFalse((root / "missing").exists())

    def test_link_replaces_regular_file_and_preserves_link_text(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "alias"
            path.write_bytes(b"previous link text")
            install_blob(path, "120000", b"../target")
            verify_blob(path, "120000", b"../target")

    def test_equal_target_contents_do_not_certify_wrong_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "old").write_bytes(b"same")
            (root / "new").write_bytes(b"same")
            path = root / "alias"
            path.symlink_to("old")
            with self.assertRaises(ValueError):
                verify_blob(path, "120000", b"new")


if __name__ == "__main__":
    unittest.main()
