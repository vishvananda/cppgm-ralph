import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('V9 release tags and scaffold preparation are gated without mutating the old run', () => {
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_v9_release.py'],
    { cwd: process.cwd(), stdio: 'pipe', timeout: 30000 });
});

test('V9 student sidecars fit native goals and omit optional PA38', () => {
  execFileSync(process.execPath, ['examples/v9sol/verify-setup.mjs'], { stdio: 'pipe', timeout: 30000 });
});

test('V9 Rust source recovery and bootstrap retain mandatory C and concise native goals', () => {
  const base='examples/v9literal/';
  const c=JSON.parse(fs.readFileSync(base+'v9literal.config.json','utf8'));
  assert.equal(c.assignmentLayout,'v9');
  assert.equal(c.initialStage,'pa33');
  assert.equal(c.stopAfterStage,'pa35');
  assert.deepEqual(c.extraStages,['pa35']);
  assert.deepEqual(c.sourceRelease.requiredPortStages,['pa38']);
  assert(c.loopGoalsEnabled && c.freshThreadPerTurn);
  assert.equal(c.codexHome,undefined);
  for (const phase of c.phases) for (const stage of ['pa33','pa35']) {
    const goal=phase.goalTemplates?.[stage]??phase.goalTemplate;
    const checks=phase.checks.map(name=>c.checks[name]).filter(x=>x.required &&
      !x.excludeStages?.includes(stage) && (!x.onlyStages || x.onlyStages.includes(stage)));
    const text=fs.readFileSync(base+'v9literal.'+goal+'.md','utf8')
      .replaceAll('{{modelValidation}}',checks.map(x=>x.command).join('\n'));
    assert(text.length+700<4000,`${stage}/${phase.name}`);
  }
});
