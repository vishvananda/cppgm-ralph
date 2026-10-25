import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSessionIsolationSpawn } from '../../session-isolation.js';
import { buildSystemdScopeSpawn } from '../../systemd-scope.js';

const configPath = path.resolve(process.argv[2]);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const stateDir = path.join(config.stateBaseDir, `${config.name}-${config.model}-${config.reasoningEffort}`);
assert(!fs.existsSync(path.join(stateDir, 'state.json')), 'Verify an unstarted run');
assert.equal(config.provider, 'claude');
assert.equal(config.model, 'opus');
assert.equal(config.reasoningEffort, 'high');
assert.equal(config.stopAfterStage, 'pa35');
assert.deepEqual(config.extraStages, ['pa34', 'pa35']);
assert(config.loopGoalsEnabled && config.freshThreadPerTurn);
assert.equal(config.codexHome, undefined);
assert.equal(config.sessionIsolation.bwrapPath, undefined);
assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, 'Use the default Claude profile');
const templates = new Set();
for (const phase of config.phases) {
  for (const name of [...phase.checks]) assert(config.checks[name], name);
  for (const name of [phase.promptTemplate, phase.goalTemplate,
    ...Object.values(phase.promptTemplates ?? {}), ...Object.values(phase.goalTemplates ?? {})]) {
    templates.add(name);
  }
  for (const stage of ['pa1', 'pa14', 'pa17', 'pa19', 'pa33', 'pa34', 'pa35']) {
    const checks = phase.checks.map(name => ({ name, ...config.checks[name] }))
      .filter(check => check.required && !check.excludeStages?.includes(stage)
        && (!check.onlyStages || check.onlyStages.includes(stage)));
    const template = phase.goalTemplates?.[stage] ?? phase.goalTemplate;
    const goal = fs.readFileSync(path.join(path.dirname(configPath), `v6opus.${template}.md`), 'utf8');
    const rendered = goal.replaceAll('{{modelValidation}}', checks.map(check =>
      `- ${check.name} [BLOCKER]: ${check.command}`).join('\n'))
      .replaceAll('{{testStage}}', stage).replaceAll('{{stageNumber}}', stage.slice(2))
      .replaceAll('{{runName}}', 'v6opus-opus-high').replaceAll('{{turnNumber}}', '500');
    assert(rendered.length + 700 < 4000, `Native goal must fit without truncation: ${stage}/${phase.name}`);
  }
}
assert.equal(templates.size, 18);
for (const template of templates) {
  const text = fs.readFileSync(path.join(path.dirname(configPath), `v6opus.${template}.md`), 'utf8');
  assert(text.includes('{{modelValidation}}'));
  assert(text.includes('native `/goal`'));
  assert(!text.includes('update_goal'));
}
const artifactDir = path.join(config.sessionIsolation.privateWriteDir, 'artifacts/scaffold-verification');
fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(artifactDir, 'probe.py'),
  'n=1\nfor i in range(500000): n=(n*1664525+1013904223)&0xffffffff\nassert n>=0\n');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const script = `set -eu
export DEBUGINFOD_URLS=
cpu=$(python3 -c 'import os; print(min(os.sched_getaffinity(0)))')
perf stat -x ';' -o ${quote(path.join(artifactDir, 'counts.txt'))} -e '{instructions:u,cycles:u}' -- taskset -c "$cpu" python3 ${quote(path.join(artifactDir, 'probe.py'))}
perf record -e cycles:u -F 99 --call-graph dwarf,8192 -o ${quote(path.join(artifactDir, 'perf.data'))} -- taskset -c "$cpu" python3 ${quote(path.join(artifactDir, 'probe.py'))}
perf report --stdio -i ${quote(path.join(artifactDir, 'perf.data'))} > ${quote(path.join(artifactDir, 'profile.txt'))}
make build > ${quote(path.join(artifactDir, 'build.log'))} 2>&1
perl scripts/cppgm_file_audit.pl --stage pa1 --paths dev
set +e
make test-pa1 > ${quote(path.join(artifactDir, 'pa1-initial.log'))} 2>&1
stage_code=$?
make test-report-through-pa1 > ${quote(path.join(artifactDir, 'pa1-through-initial.log'))} 2>&1
through_code=$?
set -e
test "$stage_code" -ne 0
test "$through_code" -ne 0
${quote(config.claudePath)} --version
timeout 90 ${quote(config.claudePath)} --print --dangerously-skip-permissions --model opus --effort high --tools '' --output-format stream-json --verbose --append-system-prompt 'This is an isolated connectivity and native-goal probe. Reply READY without tools or file changes.' '/goal Reply exactly READY and finish.' > ${quote(path.join(artifactDir, 'claude-smoke.jsonl'))}
git diff --exit-code
test -z "$(git status --short)"
`;
const providerDirectories = [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude.json')]
  .filter(value => fs.existsSync(value));
const isolated = buildSessionIsolationSpawn('/bin/sh', ['-c', script], {
  isolation: config.sessionIsolation, cwd: config.workdir, providerDirectories,
  privateWriteSettings: { workdir: config.workdir, stateDir },
});
const scoped = buildSystemdScopeSpawn(isolated.command, isolated.args, config.resourceLimits);
const result = spawnSync(scoped.command, scoped.args, { encoding: 'utf8', timeout: 300_000 });
fs.writeFileSync(path.join(artifactDir, 'verification.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
assert.equal(result.status, 0, result.error?.message ?? result.stderr);
const rows = fs.readFileSync(path.join(artifactDir, 'counts.txt'), 'utf8').split('\n')
  .map(line => line.split(';')).filter(row => ['instructions:u', 'cycles:u'].includes(row[2]));
assert.equal(rows.length, 2);
for (const row of rows) {
  assert(Number(row[0]) > 0);
  assert.equal(Number(row[4]), 100, `Counter was multiplexed: ${row[2]}`);
}
assert(fs.statSync(path.join(artifactDir, 'perf.data')).size > 0);
const events = fs.readFileSync(path.join(artifactDir, 'claude-smoke.jsonl'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));
const resultEvent = events.findLast(event => event.type === 'result');
assert(resultEvent && !resultEvent.is_error, 'Claude probe must complete successfully');
assert.equal(resultEvent.result?.trim(), 'READY');
const sessionId = events.find(event => event.type === 'system' && event.subtype === 'init')?.session_id;
assert(sessionId, 'Claude must report its probe session');
const projects = path.join(os.homedir(), '.claude', 'projects');
const transcript = fs.readdirSync(projects, { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => path.join(projects, entry.name, `${sessionId}.jsonl`))
  .find(file => fs.existsSync(file));
assert(transcript, 'The default Claude profile must retain the probe transcript');
const verdict = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  .findLast(event => event.attachment?.type === 'goal_status' && event.attachment.met === true);
assert(verdict, 'Native goal completion must be observed in the session transcript');
fs.writeFileSync(path.join(artifactDir, 'goal-completion.json'),
  `${JSON.stringify({ transcript, verdict: verdict.attachment }, null, 2)}\n`);
assert(!fs.existsSync(path.join(stateDir, 'state.json')), 'Do not start Ralph during verification');
console.log(`Unstarted scaffold, initial failures, native Opus goal, counters and sandbox: PASS (${artifactDir})`);
