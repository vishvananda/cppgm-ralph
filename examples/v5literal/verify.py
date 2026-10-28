#!/usr/bin/env python3
"""Verify real routing, zero source progress, isolation and Ralph configuration."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def command(args, *, cwd, expected=0, env=None, log=None):
    result = subprocess.run(list(map(str, args)), cwd=cwd, env=env, capture_output=True, timeout=180, text=True)
    if log:
        log.write_text(result.stdout + result.stderr)
    if result.returncode != expected:
        raise RuntimeError(f'command exit {result.returncode}, expected {expected}: {args}\n{result.stdout[-1500:]}\n{result.stderr[-1500:]}')
    return result.stdout


def mock_ralph(config, report, repo):
    # Exercise the actual config/primary/progress machinery without a model,
    # actual run state, credential changes or edits to the candidate checkout.
    with tempfile.TemporaryDirectory(prefix='literal-ralph-check-') as directory:
        root = Path(directory); work = root / 'work'; work.mkdir()
        for name in ('pa33', 'pa34'):
            (work / name).mkdir()
        command(['git', 'init', '-q'], cwd=work)
        command(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd=work)
        remote = root / 'remote.git'; command(['git', 'init', '--bare', '-q', remote], cwd=work)
        command(['git', 'remote', 'add', 'origin', remote], cwd=work)
        fake = root / 'fake-claude.cjs'
        fake.write_text('''#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
 const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
 const usage = {input_tokens:0, output_tokens:0};
 emit({type:'system',subtype:'init',session_id:'literal-config-check'});
 emit({type:'assistant',session_id:'literal-config-check',message:{id:'m',role:'assistant',model:'fake-model',usage,content:[{type:'text',text:'Configuration fixture only; no code edits.'}]}});
 emit({type:'result',subtype:'success',is_error:false,result:'done',session_id:'literal-config-check',usage});
});
'''); fake.chmod(0o755)
        test_config = {**config, 'workdir': str(work), 'provider': 'claude', 'model': 'fake-model',
                       'claudePath': str(fake), 'sessionIsolation': False, 'resourceLimits': False,
                       'stateBaseDir': str(root / 'state'), 'maxTurns': 1, 'loopGoalsEnabled': False}
        path = root / 'config.json'; path.write_text(json.dumps(test_config))
        env = dict(os.environ, RALPH_CONFIG=str(path))
        command(['node', repo / 'ralph.js'], cwd=repo, env=env, expected=1, log=report / 'ralph-config.log')
        if 'Hit the max turn limit (1) and required phase checks still fail' not in (report / 'ralph-config.log').read_text():
            raise RuntimeError('mock Ralph failed for a reason other than intentionally incomplete source progress')
        state = json.loads(next((root / 'state').glob('*/state.json')).read_text())
        status = state['lastTestStatus']
        if status['testsTotal'] != 408 or status['testsPassed'] != 0 or state['activeStage'] != 'pa33':
            raise RuntimeError('Ralph did not retain the incomplete 0/408 source inventory')
        (report / 'ralph-config-state.json').write_text(json.dumps(state, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=Path('/home/vishvananda/work'))
    args = parser.parse_args(); base = args.base.resolve()
    here = Path(__file__).resolve().parent; repo = here.parents[1]
    config = json.loads((base / 'v5literal.config.json').read_text())
    root = base / 'v5literal'; control = base / 'v5literal-control'
    python = control / 'venv/bin/python'; report = base / 'private/v5literal/artifacts/setup-verification'
    report.mkdir(parents=True, exist_ok=True)
    if 'CODEX_HOME' in (control / 'codex-v5literal').read_text():
        raise RuntimeError('launcher must use normal shared Codex authentication')
    command([python, '-m', 'unittest', 'discover', '-s', control, '-p', 'test_*.py'], cwd=root, log=report / 'harness.log')
    command([python, control / 'port_check.py', 'preflight'], cwd=root, log=report / 'preflight.log')
    text = command([python, control / 'port_check.py', 'inventory'], cwd=root, expected=1, log=report / 'inventory.log')
    if '===== TEST SUMMARY: 0 / 408 TESTS PASSED =====' not in text:
        raise RuntimeError('fresh inventory must be exactly 0/408')
    command(['python3', control / 'clone_quality.py'], cwd=root, log=report / 'quality.log')
    command(['python3', control / 'clone_check.py', 'oracle-self-check', 'pa1'], cwd=root, log=report / 'oracle-self-check.log')
    command(['python3', control / 'clone_check.py', 'case', 'pa1', 'tests/100-a.t'], cwd=root, expected=1, log=report / 'candidate-case.log')
    for tool in ('pptoken', 'posttoken', 'ppexpr', 'preproc', 'cppgm', 'abimangle', 'lowir', 'lowiropt', 'lowir2native'):
        command([root / 'obj/rust/release' / tool], cwd=root, expected=86)
    mock_ralph(config, report, repo)
    node = '''import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const [repo,configPath]=process.argv.slice(1);
const {buildSessionIsolationSpawn}=await import(pathToFileURL(repo+'/session-isolation.js'));
const c=JSON.parse(fs.readFileSync(configPath,'utf8'));
const script=`from pathlib import Path
root=Path(${JSON.stringify(c.workdir)})
probe=root/'.setup-write-check';probe.write_text('ok');probe.unlink()
Path('/tmp/v5literal-isolation-probe').write_text('private')
for p in [Path(${JSON.stringify(c.codexPath)}).parent/'manifest.json',Path(${JSON.stringify(c.codexPath)})]:
    try:
        with p.open('ab'):pass
    except OSError:pass
    else:raise AssertionError('protected path writable: '+str(p))
print('Private writes and protected control paths: PASS')
`;
const cmd=buildSessionIsolationSpawn('python3',['-c',script],{isolation:c.sessionIsolation,cwd:c.workdir,
 providerDirectories:[process.env.HOME+'/.codex',process.env.HOME+'/.claude'],
 privateWriteSettings:{workdir:c.workdir,stateDir:c.stateBaseDir+'/'+c.name+'-'+c.model+'-'+c.reasoningEffort}});
process.stdout.write(execFileSync(cmd.command,cmd.args,{encoding:'utf8'}));
'''
    command(['node', '--input-type=module', '-e', node, repo, base / 'v5literal.config.json'], cwd=root, log=report / 'isolation.log')
    if Path('/tmp/v5literal-isolation-probe').exists():
        raise RuntimeError('private /tmp leaked into host /tmp')
    if list((base / '.ralph').glob('v5literal-*')):
        raise RuntimeError('verification must not create actual run state')
    result = {'source_files': 408, 'completed': 0, 'candidate_tools': 'all nine exit 86',
              'oracle_self_check': 'pass', 'candidate_differential_case': 'correctly fails',
              'quality': 'pass', 'isolation': 'pass', 'mock_ralph': '0/408, no advancement',
              'auth': 'shared default Codex', 'worker_started': False}
    (report / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
