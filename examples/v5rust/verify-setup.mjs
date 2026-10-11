import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { buildSessionIsolationSpawn } from '../../session-isolation.js';
import { buildSystemdScopeSpawn } from '../../systemd-scope.js';
import '../../ralph-viz/test-progress-evidence.js';

const configPath = process.argv[2] ?? '/home/vishvananda/work/v5rust.config.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const source = fs.readFileSync(new URL('../../ralph.js', import.meta.url), 'utf8');
const context = vm.createContext({
  TEST_PROGRESS_EVIDENCE: globalThis.RALPH_TEST_PROGRESS_EVIDENCE,
  STAGE_COUNT_HINTS: new Map(),
  getPrimaryCheck: () => ({ command: config.checks.stageTests.command }),
});
// Use the runner's own config validation and result parser without executing main.
for (const name of ['normalizeCheckConfig', 'normalizeCheckDefinition', 'normalizePhaseConfig',
  'normalizePhaseDefinition', 'normalizePhaseAgentOverride', 'validatePhaseControlTargets',
  'normalizeStageTemplateMap', 'normalizeOptionalStageConfig', 'sanitizeIdentifier',
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
assert.deepEqual(config.extraStages, ['pa34']);
assert.equal(config.stopAfterStage, 'pa34');
const templates = new Set();
for (const phase of phases) {
  templates.add(phase.promptTemplate);
  templates.add(phase.goalTemplate);
  Object.values(phase.promptTemplates).forEach(value => templates.add(value));
  Object.values(phase.goalTemplates).forEach(value => templates.add(value));
}
assert.equal(templates.size, 10);
for (const template of templates) {
  const filename = path.join(path.dirname(configPath), `v5rust.${template}.md`);
  const text = fs.readFileSync(filename, 'utf8');
  assert(text.includes('{{modelValidation}}'), filename);
  if (template.endsWith('-goal')) assert(text.length < 2400, filename);
}
const root = fs.realpathSync(config.workdir);
const artifacts = path.join(config.sessionIsolation.privateWriteDir, 'artifacts/setup-verification');
fs.mkdirSync(artifacts, { recursive: true });
const stateDir = path.join(config.stateBaseDir, `${config.name}-${config.model}-${config.reasoningEffort}`);
assert(!fs.existsSync(path.join(stateDir, 'state.json')), 'Run must remain unstarted');
const script = `set -eu
python3 - <<'PY'
import errno
from pathlib import Path
root=Path('${root}')
probe=root/'obj/isolation-probe'
probe.parent.mkdir(exist_ok=True)
probe.write_text('writable')
probe.unlink()
for name in ['/home/vishvananda/work/references/v5rust-cpp/dev/pptoken', '/home/vishvananda/work/v5rust-control/clone_check.py', '/home/vishvananda/cppgm-extended/spec.md']:
    try:
        with open(name, 'ab'):
            pass
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES), error
    else:
        raise AssertionError('Unexpected writable reference/control: '+name)
print('Filesystem isolation: PASS')
PY
python3 /home/vishvananda/work/v5rust-control/clone_check.py preflight pa1
python3 /home/vishvananda/work/v5rust-control/clone_quality.py
/home/vishvananda/work/v5rust-control/venv/bin/python -m unittest discover -s /home/vishvananda/work/v5rust-control -p 'test_*.py'
python3 /home/vishvananda/work/v5rust-control/clone_check.py oracle-self-check pa1 > '${artifacts}/pa1-oracle.log'
set +e
python3 /home/vishvananda/work/v5rust-control/clone_check.py stage pa1 > '${artifacts}/pa1-initial.log'
code=$?
set -e
test "$code" -eq 1
`;
const isolated = buildSessionIsolationSpawn('/bin/bash', ['-c', script], {
  isolation: config.sessionIsolation, cwd: config.workdir,
  privateWriteSettings: { workdir: config.workdir, stateDir },
});
const scoped = buildSystemdScopeSpawn(isolated.command, isolated.args, config.resourceLimits);
const result = spawnSync(scoped.command, scoped.args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
fs.writeFileSync(path.join(artifacts, 'verification.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
assert.equal(result.status, 0, result.error?.message ?? result.stderr);
for (const [file, passed] of [['pa1-oracle.log', 58], ['pa1-initial.log', 0]]) {
  const text = fs.readFileSync(path.join(artifacts, file), 'utf8');
  const status = context.analyzeTestProgress(text, null, {
    command: config.checks.stageTests.command.replace('{{testStage}}', 'pa1'),
    targetStage: 'pa1', exitCode: passed ? 0 : 1,
  });
  assert.equal(status.stages.length, 1);
  assert.equal(status.stages[0].passed, passed);
  assert.equal(status.stages[0].total, 58);
  assert.equal(status.stages[0].targets.length, 58);
  assert.equal(status.stages[0].passedUpperBound, passed);
}
console.log(`Config, ten templates, bounded isolation, Rust quality, harness and PA1 routing verified: ${artifacts}`);
