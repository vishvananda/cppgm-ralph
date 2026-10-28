"""Frozen C++ definitions and current Rust syntax identities for a literal port."""
import hashlib
import re
from pathlib import Path

from tree_sitter import Language, Parser
import tree_sitter_cpp
import tree_sitter_rust

CPP = Parser(Language(tree_sitter_cpp.language()))
RUST = Parser(Language(tree_sitter_rust.language()))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def walk(node):
    yield node
    for child in node.named_children:
        yield from walk(child)


def rust_path(source):
    path = Path(source).relative_to('dev')
    return 'dev/src/translated/' + str(path.with_name(path.stem + '_' + path.suffix[1:] + '.rs'))


def freeze_source(source, data):
    tree = CPP.parse(data).root_node
    functions, errors = [], []
    for node in walk(tree):
        if node.type == 'function_definition':
            declarator = node.child_by_field_name('declarator')
            signature = data[declarator.start_byte:declarator.end_byte].decode(errors='replace') if declarator else ''
            functions.append({'id': f'{source}:{node.start_point.row + 1}:{digest(data[node.start_byte:node.end_byte])[:20]}',
                              'line': node.start_point.row + 1, 'end_line': node.end_point.row + 1,
                              'signature': ' '.join(signature.split())})
        elif node.type == 'ERROR' or node.is_missing:
            errors.append({'line': node.start_point.row + 1, 'end_line': node.end_point.row + 1,
                           'id': digest(data[node.start_byte:node.end_byte] + str(node.start_byte).encode())})
    return {'sha256': digest(data), 'rust_path': rust_path(source), 'functions': functions, 'manual_ranges': errors}


def test_only(node, data):
    while node:
        previous = node.prev_named_sibling
        while previous and previous.type in ('attribute_item', 'line_comment', 'block_comment'):
            if previous.type == 'attribute_item':
                attribute = re.sub(rb'\s+', b'', data[previous.start_byte:previous.end_byte])
                if attribute == b'#[cfg(test)]':
                    return True
            previous = previous.prev_named_sibling
        node = node.parent
    return False


def rust_syntax(data):
    tree = RUST.parse(data).root_node
    functions, unsafe, includes, declarations = [], [], [], []
    for node in walk(tree):
        content = data[node.start_byte:node.end_byte]
        if node.type == 'function_item' and node.child_by_field_name('body') and not test_only(node, data):
            name = node.child_by_field_name('name')
            scopes = []
            parent = node.parent
            while parent:
                if parent.type in ('impl_item', 'trait_item', 'mod_item', 'function_item'):
                    body = parent.child_by_field_name('body')
                    scopes.append(data[parent.start_byte:body.start_byte if body else parent.end_byte])
                parent = parent.parent
            scope = b'::'.join(reversed(scopes))
            functions.append({'sha256': digest(scope + b'\0' + content), 'line': node.start_point.row + 1,
                              'scope': scope.decode(),
                              'name': data[name.start_byte:name.end_byte].decode() if name else ''})
        if node.type in ('struct_item', 'enum_item', 'type_item', 'function_item', 'const_item', 'static_item', 'trait_item', 'macro_definition', 'use_declaration') and not test_only(node, data):
            declarations.append({'kind': node.type, 'line': node.start_point.row + 1})
        if node.type in ('unsafe_block', 'foreign_mod_item') or (node.type in ('function_modifiers', 'impl_item', 'trait_item') and content.lstrip().startswith(b'unsafe')):
            unsafe.append({'sha256': digest(str(node.start_byte).encode() + b'\0' + content), 'line': node.start_point.row + 1, 'kind': node.type})
        if node.type == 'macro_invocation' and content.lstrip().startswith((b'include!', b'include_str!', b'include_bytes!')):
            includes.append({'line': node.start_point.row + 1, 'text': content.decode()})
    return {'parse_error': tree.has_error, 'functions': functions, 'unsafe': unsafe, 'includes': includes, 'declarations': declarations}
