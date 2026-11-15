#!/usr/bin/env python3
"""Verify that a tagged course export belongs to one exact tagged source release."""
import argparse
import json
from pathlib import Path
import subprocess

V9_SOURCE = 'bb09801053e48486beebe014071a71353ce9be0b'


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def verify_release(source, assignments, expected=V9_SOURCE, version='v0.9.0', course='assignments-v9'):
    source, assignments = Path(source).resolve(), Path(assignments).resolve()
    # Resolve refs/tags explicitly: a branch or working tree cannot substitute.
    source_sha = git(source, 'rev-parse', '--verify', f'refs/tags/{version}^{{commit}}')
    course_sha = git(source, 'rev-parse', '--verify', f'refs/tags/{course}^{{commit}}')
    if source_sha != expected or course_sha != expected:
        raise ValueError('source release/course tags must both resolve to ' + expected)
    assignment_sha = git(assignments, 'rev-parse', '--verify', f'refs/tags/{version}^{{commit}}')
    manifest = git(assignments, 'show', f'{assignment_sha}:reference-binaries/manifest.tsv')
    source_rows = [row.split('\t', 1)[1] for row in manifest.splitlines() if row.startswith('source_sha\t')]
    if source_rows != [expected]:
        raise ValueError('tagged assignments reference manifest does not identify the source release')
    binaries = [row.split('\t')[1] for row in manifest.splitlines() if row.startswith('binary\t')]
    if 'cppgm' not in binaries or 'cppgm++' in binaries:
        raise ValueError('v9 reference bundle must expose the renamed cppgm tool')
    for stage in ['pa29', 'pa33', 'pa34', 'pa35', 'pa36', 'pa37', 'pa38']:
        git(assignments, 'cat-file', '-e', f'{assignment_sha}:{stage}/README.md')
    return {'source_repository': str(source), 'source_revision': expected,
            'source_tag': version, 'course_tag': course, 'assignments_repository': str(assignments),
            'assignments_revision': assignment_sha, 'assignments_tag': version,
            'reference_binaries': binaries, 'required_through': 'pa37', 'optional_course_stages': ['pa38']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--assignments', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify_release(args.source, args.assignments), indent=2))


if __name__ == '__main__':
    main()
