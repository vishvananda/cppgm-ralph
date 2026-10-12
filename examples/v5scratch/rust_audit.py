#!/usr/bin/env python3
"""Rust syntax-aware companion to cppgm_file_audit.pl (tree-sitter 0.25)."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import sys

from tree_sitter import Language, Parser
import tree_sitter_rust

PARSER = Parser(Language(tree_sitter_rust.language()))
FUNCTIONS = {"function_item", "closure_expression", "macro_definition"}
COMMENTS = {"line_comment", "block_comment"}
PHASES = {"lex", "preprocess", "syntax", "types", "sema", "abi", "lower", "lowir", "opt", "native", "support"}
ALLOWED_DEPENDENCIES = {
    "support": set(), "types": {"support", "lex"},
    "lex": {"support", "types"}, "preprocess": {"support", "lex", "types"},
    "syntax": {"support", "lex", "types", "preprocess"},
    "sema": {"support", "lex", "types", "preprocess", "syntax", "abi"},
    "abi": {"support", "lex", "types"}, "lowir": {"support", "types"},
    "lower": {"support", "lex", "types", "syntax", "sema", "abi", "lowir"},
    "opt": {"support", "types", "lowir"},
    "native": {"support", "types", "abi", "lowir"},
}


def walk(node):
    yield node
    for child in node.children:
        yield from walk(child)


def code_rows(tree):
    rows = set()
    def visit(node):
        if node.type in COMMENTS:
            return
        if not node.children:
            rows.update(range(node.start_point.row, node.end_point.row + 1))
        else:
            for child in node.children:
                visit(child)
    visit(tree)
    return rows


def node_text(node, data):
    return data[node.start_byte:node.end_byte].decode()


def nesting(node, depth=0):
    # Match arms and lexical blocks represent nested decisions/storage scopes.
    next_depth = depth + (node.type in {"block", "match_block"})
    return max([next_depth, *(nesting(child, next_depth) for child in node.children)])


def inspect_file(path, root, roles):
    data = path.read_bytes()
    tree = PARSER.parse(data).root_node
    relative = path.relative_to(root).as_posix()
    errors = []
    if tree.has_error:
        errors.append("Rust syntax could not be audited")
    rows = code_rows(tree)
    role = roles.get(relative, "implementation")
    caps = {"implementation": 3000, "interface": 2400, "model": 1800}
    if role not in caps:
        errors.append(f"unrecognized module role: {role}")
        role = "implementation"
    if len(rows) > caps[role]:
        errors.append(f"{len(rows)} code lines exceeds {role} cap {caps[role]}")
    if re.search(r"(?:part|chunk|split)[_-]?\d", path.stem):
        errors.append("mechanical implementation fragment filename")
    if not re.fullmatch(r"[a-z][a-z0-9_]*", path.stem):
        errors.append("Rust module/file names must use snake_case")
    text = data.decode()
    phase = any(part in PHASES for part in path.relative_to(root).parts)
    parts = path.relative_to(root).parts
    owner = parts[2] if len(parts) > 3 and parts[:2] == ("dev", "src") else None
    for node in walk(tree):
        content = node_text(node, data)
        if node.type in {"use_declaration", "scoped_identifier", "scoped_type_identifier"} and owner in ALLOWED_DEPENDENCIES:
            dependencies = re.findall(r"\bcrate\s*::\s*(\w+)", content)
            grouped = re.search(r"\bcrate\s*::\s*\{([^;]+)", content)
            if grouped:
                dependencies.extend(re.findall(r"\b(" + "|".join(PHASES | {"driver"}) + r")\b", grouped[1]))
            for dependency in set(dependencies):
                if dependency != owner and dependency not in ALLOWED_DEPENDENCIES[owner]:
                    errors.append(f"line {node.start_point.row + 1}: forbidden phase dependency {owner} -> {dependency}")
        if node.type in {"unsafe_block", "foreign_mod_item"} or (
                node.type in {"function_modifiers", "impl_item", "trait_item"}
                and re.match(r"\s*unsafe\b", content)):
            errors.append(f"line {node.start_point.row + 1}: unsafe/FFI implementation is prohibited")
        if node.type in FUNCTIONS:
            length = sum(node.start_point.row <= row <= node.end_point.row for row in rows)
            dispatch = any(child.type == "match_block" and
                           sum(arm.type == "match_arm" for arm in child.named_children) >= 8
                           for child in walk(node))
            if length > (360 if dispatch else 240):
                errors.append(f"line {node.start_point.row + 1}: function/closure has {length} code lines")
            depth = max(0, nesting(node) - 1)
            if depth > 6:
                severity = "hard limit 8 exceeded" if depth > 8 else "warning threshold 6 exceeded"
                errors.append(f"line {node.start_point.row + 1}: nesting {depth}; {severity}")
        if node.type == "macro_invocation" and re.match(r"(?:include|include_str|include_bytes)\s*!", content):
            errors.append(f"line {node.start_point.row + 1}: include macro requires reviewed vocabulary provenance")
        if node.type in {"attribute_item", "inner_attribute_item"}:
            if re.search(r"\b(?:allow|expect)\s*\(\s*(?:warnings|clippy::(?:all|pedantic))\b", content):
                errors.append("blanket lint suppression")
            if "expect(" in content and "reason" not in content:
                errors.append("lint expectation must state a reason")
        if node.type in {"use_declaration", "scoped_identifier", "macro_invocation"}:
            compact = re.sub(r"\s+", "", content)
            in_src = path.relative_to(root).parts[:2] == ("dev", "src")
            scoped = re.sub(r"\s*::\s*", "::", content)
            if in_src and (re.search(r"(?:std|core)::env|(?:option_env|env)!", compact) or
                           re.search(r"std::\s*\{[^;]*\benv\b", scoped)):
                errors.append(f"line {node.start_point.row + 1}: environment read/import under dev/src")
            if phase and (re.search(r"std::(?:process|os)|libc::|Command::", compact) or
                          re.search(r"std::\s*\{[^;]*\b(?:process|os)\b", scoped)):
                errors.append(f"line {node.start_point.row + 1}: process/platform access in a compiler phase")
    # Scan literal paths too: fixture and reference lookup is not a compiler API.
    for node in walk(tree):
        if node.type in {"string_literal", "raw_string_literal"}:
            literal = node_text(node, data)
            if re.search(r"(?:pa\d+/tests|v5rust-cpp|\.ref(?:\b|\.)|cppgm-extended/dev)", literal):
                errors.append("compiler contains a fixture/reference dependency")
    lines = text.splitlines()
    normalized = []
    for row in sorted(rows):
        if row >= len(lines) or not lines[row].strip():
            continue
        line = lines[row].strip()
        score = line.count(";") + line.count("{") + line.count("}") + len(re.findall(r"\b(?:if|else|match|for|while|loop)\b", line))
        if line.count(";") >= 24 or (len(line) >= 900 and score >= 28) or (len(line) >= 1600 and score >= 18):
            errors.append(f"line {row + 1}: compressed code")
        normalized.append(re.sub(r"\s+", " ", line))
    if path.stem in {"common", "misc", "utils", "helpers"} and len(lines) > 250:
        errors.append("catch-all file exceeds 250 physical lines")
    return errors, normalized


def audit(root):
    role_path = root / "scripts/rust-module-roles.json"
    roles = json.loads(role_path.read_text()) if role_path.exists() else {}
    files = sorted((root / "dev").rglob("*.rs"))
    errors = []
    windows = {}
    stems = defaultdict(list)
    for path in files:
        problems, normalized = inspect_file(path, root, roles)
        errors.extend(f"{path.relative_to(root)}: {problem}" for problem in problems)
        stems[re.split(r"[_-]", path.stem)[0]].append(path)
        for offset in range(max(0, len(normalized) - 27)):
            window = "\n".join(normalized[offset:offset + 28])
            if len(window) < 240:
                continue
            previous = windows.get(window)
            if previous and (previous[0] != path or abs(previous[1] - offset) >= 28):
                errors.append(f"{path.relative_to(root)}: duplicate 28-line code block also in {previous[0].relative_to(root)}")
                break
            windows[window] = (path, offset)
    for stem, paths in stems.items():
        if stem not in {"mod", "main", "lib"} and len(paths) >= 7:
            errors.append(f"repeated filename stem {stem}: {len(paths)} files; review ownership")
    for role in roles:
        if not (root / role).is_file():
            errors.append(f"module role names a missing file: {role}")
    for error in errors:
        print(error)
    print(f"Rust file audit: {len(files)} files; {len(errors)} findings")
    return not errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    sys.exit(0 if audit(parser.parse_args().root.resolve()) else 1)
