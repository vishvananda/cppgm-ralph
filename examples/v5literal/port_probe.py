#!/usr/bin/env python3
"""Run a reusable exact differential recipe; use port_check.py probe for receipts."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

import clone_common as common


def run_recipe(recipe_path):
    recipe_path = Path(recipe_path).resolve()
    recipe = json.loads(recipe_path.read_text())
    if not recipe.get('cases'):
        raise ValueError('probe needs at least one exact comparison case')
    directory = common.ARTIFACTS / 'support-probes'
    directory.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='recipe-', dir=directory))
    environment = common.clean_env()
    values = {'root': str(common.ROOT), 'reference': str(common.REFERENCE),
              'out': str(directory), 'python': str(common.CONTROL / 'venv/bin/python'),
              'cxx': shutil.which('g++', path=environment.get('PATH')) or 'g++',
              'rustc': shutil.which('rustc', path=environment.get('PATH')) or 'rustc'}

    def expand(value):
        for key, replacement in values.items():
            value = str(value).replace('{' + key + '}', replacement)
        return value

    def source(value):
        path = Path(expand(value))
        return path if path.is_absolute() else common.ROOT / path

    paths = {recipe_path, *[source(p) for p in recipe.get('inputs', [])]}
    for build in recipe.get('builds', []):
        paths.update(source(p) for p in build['sources'])
        paths.update(source(p) for p in build.get('force_include', []))
    for case in recipe['cases']:
        if 'stdin_file' in case:
            paths.add(source(case['stdin_file']))
    before = {str(path): common.file_digest(path) for path in sorted(paths)}
    steps = []

    def execute(command, label, data=b''):
        command = [expand(part) for part in command]
        # Python probes and review scripts share the installed parser environment.
        if command[0] in ('python', 'python3', sys.executable):
            command[0] = values['python']
        code, stdout, stderr = common.run(command, cwd=directory, env=environment,
            stdin=data, timeout=recipe.get('timeout_seconds', 180))
        (directory / (label + '.stdout')).write_bytes(stdout)
        (directory / (label + '.stderr')).write_bytes(stderr)
        steps.append({'label': label, 'command': command, 'exit': code})
        common.write_json(directory / 'steps.json', steps)
        return code, stdout, stderr

    try:
        for key, value in recipe.get('environment', {}).items():
            environment[key] = expand(value)
        for index, command in enumerate(recipe.get('prepare', [])):
            code, _, _ = execute(command, f'prepare-{index}')
            if code:
                raise RuntimeError(f'prepare-{index} failed; inspect raw stderr')
        for index, build in enumerate(recipe.get('builds', [])):
            name = build['name']
            if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
                raise ValueError('build name must be a simple filename')
            sources = [str(source(p)) for p in build['sources']]
            if build['language'] == 'cpp':
                command = [values['cxx'], '-std=gnu++11', '-O2',
                           '-I' + str(common.REFERENCE / 'dev/src')]
                for header in build.get('force_include', []):
                    command += ['-include', str(source(header))]
                command += [expand(p) for p in build.get('flags', [])] + sources
            elif build['language'] == 'rust':
                if len(sources) != 1:
                    raise ValueError('Rust build needs one crate root')
                command = [values['rustc'], '--edition=2024', '-C', 'opt-level=2',
                           *[expand(p) for p in build.get('flags', [])], *sources]
            else:
                raise ValueError('build language must be cpp or rust')
            code, _, _ = execute([*command, '-o', str(directory / name)], f'build-{index}')
            if code:
                raise RuntimeError(f'build-{index} failed; inspect raw stderr')
        for index, case in enumerate(recipe['cases']):
            data = source(case['stdin_file']).read_bytes() if 'stdin_file' in case else case.get('stdin', '').encode()
            expected = case.get('exit', 0)
            if not isinstance(expected, int) or expected < 0 or expected >= 128 or expected in (86, 101, 124):
                raise ValueError('panic, signal, timeout and scaffold exits cannot be accepted')
            outputs = [Path(p) for p in recipe.get('outputs', [])]
            for path in outputs:
                if path.is_absolute() or '..' in path.parts or path == Path('.'):
                    raise ValueError('generated outputs must stay inside the probe directory')

            def collect(command, label):
                for path in outputs:
                    target = directory / path
                    if not target.resolve().is_relative_to(directory):
                        raise ValueError('generated output escaped the probe directory')
                    target.unlink(missing_ok=True)
                result = execute(command, label, data)
                if result[0] != expected:
                    raise RuntimeError(f'{label}: exit {result[0]}, expected {expected}')
                files = {}
                for path in outputs:
                    target = directory / path
                    if not target.resolve().is_relative_to(directory):
                        raise ValueError('generated output escaped the probe directory')
                    files[str(path)] = target.read_bytes() if target.exists() else None
                    if expected == 0 and files[str(path)] is None:
                        raise RuntimeError(f'{label}: missing required generated output {path}')
                    if files[str(path)] is not None:
                        snapshot = directory / (label + '.files') / path
                        snapshot.parent.mkdir(parents=True, exist_ok=True)
                        snapshot.write_bytes(files[str(path)])
                return result, files

            reference_command = case.get('reference', recipe.get('reference'))
            candidate_command = case.get('candidate', recipe.get('candidate'))
            if not reference_command or not candidate_command:
                raise ValueError('case needs reference and candidate commands')
            reference = collect(reference_command, f'case-{index}-reference')
            candidate = collect(candidate_command, f'case-{index}-candidate')
            if reference != candidate:
                raise RuntimeError(f'case-{index}: exit/stdout/stderr/generated bytes differ')
        if before != {str(path): common.file_digest(path) for path in sorted(paths)}:
            raise RuntimeError('probe inputs changed during validation')
        common.write_json(directory / 'manifest.json', {'kind': 'literal-source-probe',
            'cases': len(recipe['cases']), 'inputs': before, 'commands': steps,
            'scope': 'Focused source evidence; does not satisfy course/bootstrap acceptance'})
        print(f'Exact probe: {len(recipe["cases"])} cases passed; {directory}/manifest.json')
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f'Probe failed: {error}; evidence: {directory}', file=sys.stderr)
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recipe', type=Path)
    return run_recipe(parser.parse_args().recipe)


if __name__ == '__main__':
    sys.exit(main())
