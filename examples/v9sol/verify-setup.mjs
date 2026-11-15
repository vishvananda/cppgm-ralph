import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const configPath = path.resolve(process.argv[2] ?? new URL('v9sol.config.json', import.meta.url).pathname);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert.equal(config.assignmentLayout, 'v9');
assert.equal(config.name, 'v9sol');
assert.equal(config.provider, 'codex');
assert.equal(config.model, 'gpt-6.1-sol');
assert.equal(config.reasoningEffort, 'high');
assert.equal(config.stopAfterStage, 'pa37');
assert.deepEqual(config.extraStages, ['pa35', 'pa36']);
assert(config.loopGoalsEnabled && config.freshThreadPerTurn);
assert.equal(config.codexHome, undefined);
assert.match(config.sourceRelease.sourceRevision, /^[0-9a-f]{40}$/);
const state = path.join(config.stateBaseDir, `${config.name}-${config.model}-${config.reasoningEffort}`, 'state.json');
assert(!fs.existsSync(state), 'V9 student run must remain unstarted');
const templates = new Set();
for (const phase of config.phases) {
  for (const check of phase.checks) assert(config.checks[check], check);
  for (const name of [phase.promptTemplate, phase.goalTemplate,
    ...Object.values(phase.promptTemplates ?? {}), ...Object.values(phase.goalTemplates ?? {})]) templates.add(name);
  for (let n = 1; n <= 37; n++) {
    const stage = `pa${n}`;
    const checks = phase.checks.map(name => ({ name, ...config.checks[name] }))
      .filter(check => check.required && !check.excludeStages?.includes(stage)
        && (!check.onlyStages || check.onlyStages.includes(stage)));
    const template = phase.goalTemplates?.[stage] ?? phase.goalTemplate;
    const goal = fs.readFileSync(path.join(path.dirname(configPath), `v9sol.${template}.md`), 'utf8');
    const rendered = goal.replaceAll('{{modelValidation}}', checks.map(check =>
      `- ${check.name} [BLOCKER]: ${check.command}`).join('\n'))
      .replaceAll('{{testStage}}', stage).replaceAll('{{stageNumber}}', String(n))
      .replaceAll('{{runName}}', 'v9sol-gpt-6.1-sol-high').replaceAll('{{turnNumber}}', '500');
    assert(rendered.length + 700 < 4000, `${stage}/${phase.name}: native goal too long`);
  }
}
assert.equal(templates.size, 18);
for (const name of templates) {
  const text = fs.readFileSync(path.join(path.dirname(configPath), `v9sol.${name}.md`), 'utf8');
  assert(text.includes('{{modelValidation}}') && text.includes('`update_goal`'), name);
  assert(!/cppgm\+\+|pa34 compare|pa35 test-progress/.test(text), name);
}
console.log('V9 Sol: PA1–37, optional PA38 excluded, 18 templates, native goal sizes and default credentials PASS; no worker started');
