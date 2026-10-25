import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { buildSessionIsolationSpawn } from '../../session-isolation.js';
import { buildSystemdScopeSpawn } from '../../systemd-scope.js';
import '../../ralph-viz/test-progress-evidence.js';

const configPath = path.resolve(process.argv[2]);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const stateDir = path.join(config.stateBaseDir, `${config.name}-${config.model}-${config.reasoningEffort}`);
assert(!fs.existsSync(path.join(stateDir, 'state.json')), 'Setup verification requires an unstarted run');
assert.equal(config.stopAfterStage, 'pa33');
assert.deepEqual(config.extraStages, []);
assert(config.loopGoalsEnabled && config.freshThreadPerTurn);
assert.equal(config.codexHome, undefined, 'Use the default Codex profile');
assert.equal(config.sessionIsolation.bwrapPath, undefined, 'Use ordinary Ralph storage isolation');
assert.equal(config.model, 'gpt-6.1-sol');
assert.equal(config.reasoningEffort, 'high');
const source = fs.readFileSync(new URL('../../ralph.js', import.meta.url), 'utf8');
const context = vm.createContext({
  TEST_PROGRESS_EVIDENCE: globalThis.RALPH_TEST_PROGRESS_EVIDENCE,
  STAGE_COUNT_HINTS: new Map(),
  getPrimaryCheck: () => ({ command: config.checks.stageTests.command }),
});
for (const name of ['normalizeCheckConfig', 'normalizeCheckDefinition', 'normalizePhaseConfig',
  'normalizePhaseDefinition', 'normalizePhaseAgentOverride', 'validatePhaseControlTargets',
  'normalizeStageTemplateMap', 'normalizeStagePhaseMap', 'normalizeOptionalStageConfig', 'sanitizeIdentifier',
  'sanitizeOptionalTemplateName', 'sanitizeOptionalIdentifier', 'normalizeCheckDependencyList',
  'normalizeStageList', 'normalizeStageName', 'normalizeTestSubset', 'parseBoolean', 'parsePositiveInt']) {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert(declaration, name);
  vm.runInContext(declaration[0], context);
}
vm.runInContext(source.slice(source.indexOf('function analyzeTestProgress('),
  source.indexOf('function buildTestStatusLines(')), context);
const checks = context.normalizeCheckConfig(config.checks, config.testCommand);
const phases = context.normalizePhaseConfig(config.phases, checks);
assert.equal(phases.length, 3);
assert.equal(phases[0].checkpointPhaseEvery, 3);
const templates = new Set(phases.flatMap(phase => [phase.promptTemplate, phase.goalTemplate]));
assert.equal(templates.size, 6);
for (const template of templates) {
  const text = fs.readFileSync(path.join(path.dirname(configPath), `v5scratch.${template}.md`), 'utf8');
  assert(text.includes('{{modelValidation}}'));
}
const artifactDir = path.join(config.sessionIsolation.privateWriteDir, 'artifacts/scaffold-verification');
fs.mkdirSync(artifactDir, { recursive: true });
const script = `set -eu
export CARGO_HOME='${config.sessionIsolation.privateWriteDir}/cache/cargo'
export CARGO_TARGET_DIR='${fs.realpathSync(config.workdir)}/obj/rust'
export CLIPPY_CONF_DIR='${fs.realpathSync(config.workdir)}/dev'
export DEBUGINFOD_URLS=
python3 - <<'PY'
from pathlib import Path
import errno
assert Path('/home/vishvananda/cppgm-ralph').is_dir(), 'Host paths must remain readable'
for name in ['${path.dirname(config.codexPath)}/rust_audit.py']:
    assert Path(name).is_file(), name
    try:
        with open(name,'ab'): pass
    except OSError as error:
        assert error.errno in (errno.EROFS,errno.EACCES), error
    else:
        raise AssertionError('Expected protected runtime/profile: '+name)
assert Path('${config.workdir}').resolve()==Path('${fs.realpathSync(config.workdir)}')
print('Ordinary storage isolation and protected runtime: PASS')
PY
make build
make rust-quality
make audit-rust
git var GIT_AUTHOR_IDENT > '${artifactDir}/git-author.txt'
'${config.codexPath}' --version
'${config.codexPath}' app-server generate-json-schema --experimental --out '${artifactDir}/codex-schema' > '${artifactDir}/schema.log'
set +e
make test-pa1 > '${artifactDir}/pa1-initial.log' 2>&1
stage_code=$?
make test-report-through-pa1 > '${artifactDir}/pa1-through-initial.log' 2>&1
through_code=$?
set -e
test "$stage_code" -ne 0
test "$through_code" -ne 0
python3 - <<'PY'
import os,subprocess
from pathlib import Path
cpu=min(os.sched_getaffinity(0))
probe=Path('${artifactDir}/perf-probe.py')
probe.write_text('n=1\\nfor i in range(500000): n=(n*1664525+1013904223)&0xffffffff\\nassert n>=0\\n')
subprocess.run(['perf','stat','-x',';','-o','${artifactDir}/counts.txt','-e','{instructions:u,cycles:u}','--','taskset','-c',str(cpu),'python3',str(probe)],check=True)
subprocess.run(['perf','record','-e','cycles:u','-F','99','--call-graph','dwarf,8192','-o','${artifactDir}/perf.data','--','taskset','-c',str(cpu),'python3',str(probe)],check=True)
with open('${artifactDir}/profile.txt','w') as out:
    subprocess.run(['perf','report','--stdio','-i','${artifactDir}/perf.data'],stdout=out,check=True,timeout=30)
print('Hardware counter/sampling probes: PASS')
PY
perl scripts/ensure_reference_binaries.pl
`;
const isolated = buildSessionIsolationSpawn('/bin/bash', ['-c', script], {
  isolation: config.sessionIsolation, cwd: config.workdir,
  privateWriteSettings: { workdir: config.workdir, stateDir },
});
const scoped = buildSystemdScopeSpawn(isolated.command, isolated.args, config.resourceLimits);
const result = spawnSync(scoped.command, scoped.args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(path.join(artifactDir, 'verification.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
for (const file of ['pa1-initial.log', 'pa1-through-initial.log']) {
  const status = context.analyzeTestProgress(fs.readFileSync(path.join(artifactDir, file), 'utf8'), null, {
    command: file.includes('through') ? 'make test-report-through-pa1' : 'make test-pa1',
    targetStage: 'pa1', exitCode: 1,
  });
  assert.equal(status.stages.length, 1, file);
  assert.equal(status.stages[0].passed, 0, file);
  assert.equal(status.stages[0].total, 58, file);
}
const schemaFiles = fs.readdirSync(path.join(artifactDir, 'codex-schema/v2'));
assert(schemaFiles.some(file => file.includes('ThreadGoalSet')), 'Native goal protocol missing');
const rows = fs.readFileSync(path.join(artifactDir, 'counts.txt'), 'utf8').split('\n')
  .map(line => line.split(';')).filter(row => ['instructions:u', 'cycles:u'].includes(row[2]));
assert.equal(rows.length, 2);
for (const row of rows) {
  assert(Number(row[0]) > 0);
  assert.equal(Number(row[4]), 100, `Multiplexed ${row[2]}`);
}
assert(fs.readFileSync(path.join(artifactDir, 'profile.txt'), 'utf8').includes('cycles:u'));
const tools = ['pptoken','posttoken','ppexpr','preproc','cppgm++','abimangle','lowir','lowiropt','lowir2native'];
for (const tool of tools) {
  assert.equal(fs.readFileSync(path.join(config.workdir, 'dev', tool)).subarray(0,4).toString(), '\x7fELF', tool);
}
console.log(`Config, six templates, Rust quality, ordinary storage isolation, PA1 routing, native goal schema and hardware counters verified: ${artifactDir}`);
