#!/usr/bin/env python3
"""Verify that a tagged course export belongs to one exact tagged source release."""
import argparse
import json
from pathlib import Path
import re
import subprocess

V9_SOURCE = 'bb09801053e48486beebe014071a71353ce9be0b'


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def verify_release(source, assignments, expected=V9_SOURCE, version='v0.9.0', course='assignments-v9', assignments_revision=None):
    source, assignments = Path(source).resolve(), Path(assignments).resolve()
    # Resolve refs/tags explicitly: a branch or working tree cannot substitute.
    source_sha = git(source, 'rev-parse', '--verify', f'refs/tags/{version}^{{commit}}')
    course_sha = git(source, 'rev-parse', '--verify', f'refs/tags/{course}^{{commit}}')
    if source_sha != expected:
        raise ValueError('source release tag must resolve to ' + expected)
    # A patch release advances the compiler without moving the course's base tag.
    subprocess.run(['git', '-C', str(source), 'merge-base', '--is-ancestor', course_sha, expected], check=True)
    if assignments_revision is not None and not re.fullmatch('[0-9a-f]{40}', assignments_revision):
        raise ValueError('assignments revision must be an immutable full commit SHA')
    assignment_ref = assignments_revision or f'refs/tags/{version}'
    assignment_sha = git(assignments, 'rev-parse', '--verify', f'{assignment_ref}^{{commit}}')
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
            'source_tag': version, 'course_tag': course, 'course_revision': course_sha,
            'assignments_repository': str(assignments), 'assignments_revision': assignment_sha,
            'assignments_tag': None if assignments_revision else version,
            'reference_binaries': binaries, 'required_through': 'pa37', 'optional_course_stages': ['pa38']}


def arguments(parser):
    parser.add_argument('--version', default='v0.9.0')
    parser.add_argument('--source-revision', default=V9_SOURCE)
    parser.add_argument('--assignments-revision', help='full exported commit SHA; its manifest must match the source release')


def options(args):
    return dict(version=args.version, expected=args.source_revision, assignments_revision=args.assignments_revision)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--assignments', type=Path, required=True)
    arguments(parser)
    args = parser.parse_args()
    print(json.dumps(verify_release(args.source, args.assignments, **options(args)), indent=2))


if __name__ == '__main__':
    main()
