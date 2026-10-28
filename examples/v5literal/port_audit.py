#!/usr/bin/env python3
"""Mechanical correspondence and reviewed unsafe; no style-driven rewrites."""
import json
import argparse
import re
from pathlib import Path
import sys

import clone_common as common
from port_inventory import rust_syntax


def audit(root=common.ROOT):
    root = Path(root)
    ledger = json.loads((root / 'port/unsafe.json').read_text())
    entries = ledger.get('entries', [])
    indexed = {}
    errors = []
    for item in entries:
        key = (item.get('file'), item.get('sha256'))
        if key in indexed:
            errors.append(f'duplicate unsafe record: {key}')
        indexed[key] = item
    observed = set()
    mapped = {str((root / spec['rust_path']).resolve()) for spec in
              json.loads((root / 'port/inventory.json').read_text())['sources'].values()}
    count = 0
    for file in sorted((root / 'dev').rglob('*.rs')):
        relative = file.relative_to(root).as_posix()
        data = file.read_bytes()
        syntax = rust_syntax(data)
        count += 1
        if syntax['parse_error']:
            errors.append(f'{relative}: invalid Rust syntax')
        for item in syntax['unsafe']:
            key = (relative, item['sha256'])
            observed.add(key)
            record = indexed.get(key, {})
            if not all(isinstance(record.get(k), str) and len(record[k].split()) >= 4
                       for k in ('reason', 'invariants', 'validation')):
                errors.append(f'{relative}:{item["line"]}: unsafe construct lacks exact safety review')
            if not record.get('source'):
                errors.append(f'{relative}:{item["line"]}: unsafe review lacks C++ correspondence or compatibility rationale')
        # Embedded source/fixture/reference bytes cannot implement compiler work.
        for item in syntax['includes']:
            literal = re.fullmatch(r'include!\s*\(\s*"([^"]+)"\s*\)', item['text'])
            mapped_include = literal and str((file.parent / literal[1]).resolve()) in mapped
            if relative != 'dev/bin/builtin_host_configuration.rs' and not mapped_include:
                errors.append(f'{relative}:{item["line"]}: include macro requires an explicit owner-reviewed scaffold change')
    for key in indexed.keys() - observed:
        errors.append(f'stale unsafe review: {key}')
    for error in errors:
        print(error)
    print(f'Literal Rust audit: {count} files; {len(observed)} unsafe constructs; {len(errors)} findings')
    return not errors


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=common.ROOT)
    sys.exit(0 if audit(parser.parse_args().root) else 1)
