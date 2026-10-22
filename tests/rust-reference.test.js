import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const ralph = fs.readFileSync(path.join(repo, 'ralph.js'), 'utf8');
const functions = ['normalizeCheckConfig', 'normalizeCheckDefinition', 'normalizePhaseConfig',
  'normalizePhaseDefinition', 'normalizePhaseAgentOverride', 'validatePhaseControlTargets',
  'normalizeStageTemplateMap', 'normalizeOptionalStageConfig', 'sanitizeIdentifier',
  'sanitizeOptionalTemplateName', 'sanitizeOptionalIdentifier', 'normalizeCheckDependencyList',
  'normalizeStageList', 'normalizeStageName', 'normalizeTestSubset', 'parseBoolean', 'parsePositiveInt'];

for (const [name, profile] of [['v5scratch', 'student'], ['v5rust', 'port']]) {
  test(`${name}: prepare reference stages without modifying the run`, (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-reference-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'checkout');
    const course = path.join(temporary, 'course');
    const bundle = path.join(temporary, 'bundle');
    const out = path.join(temporary, 'prepared');
    for (const dir of [root, bundle, course]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Original instructions.\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Original specification.\n');
    fs.writeFileSync(path.join(bundle, 'reference-bundle.json'), '{"commit":"fixture","files":{}}');
    const shipped = ['scripts/reference_bootstrap.py', 'pa34/README.md', 'pa35/README.md',
      'pa35/Makefile', 'pa35/scripts/PA35.pm', 'pa35/scripts/check.pl'];
    for (const file of shipped) {
      fs.mkdirSync(path.dirname(path.join(course, file)), { recursive: true });
      fs.writeFileSync(path.join(course, file), `fixture ${file}\n`);
    }
    fs.mkdirSync(path.join(course, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(course, 'scripts/rust_course.json'), JSON.stringify({ course: 'rust-reference', branch: 'rust-course' }));
    fs.writeFileSync(path.join(course, 'pa34/README.md'), '# Rust compiler reference bootstrap\n\nA need not equal B. C == D.\n\n```sh\npython3 scripts/reference_bootstrap.py final --out obj/reference-bootstrap\n```\n');
    fs.writeFileSync(path.join(course, 'README.md'), '# cppgm assignments\nRust course overview.\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'PA35 is reference material, not an optimization objective for this port.\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Original instructions.\nThe run stops after the PA33 audit. PA34/PA35 remain handout material and have\nno exit criteria in this run.\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'choices, define acceptance. PA34 and PA35 are deferred.\n');
    const originalAgents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    if (profile === 'port') {
      fs.mkdirSync(path.join(root, 'scripts/clone'), { recursive: true });
      fs.writeFileSync(path.join(root, 'CLONE_CONTRACT.md'), 'Original port contract.\n');
      fs.writeFileSync(path.join(root, 'scripts/clone/manifest.json'), JSON.stringify({ protected: {}, oracle_tools: { fixture: 'hash' } }));
    }
    const original = JSON.parse(fs.readFileSync(path.join(repo, 'examples', name, `${name}.config.json`)));
    original.workdir = root;
    const input = path.join(temporary, `${name}.config.json`);
    const serialized = JSON.stringify(original);
    fs.writeFileSync(input, serialized);
    const command = ['examples/rust-reference/prepare.py', '--config', input, '--course', course,
      '--bundle', bundle, '--profile', profile, '--out', out];
    const result = spawnSync('python3', command, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(input, 'utf8'), serialized);
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), originalAgents);
    const candidate = path.join(out, 'candidate');
    assert(!fs.existsSync(path.join(candidate, 'REFERENCE_STAGES.md')));
    assert(!fs.readFileSync(path.join(candidate, 'AGENTS.md'), 'utf8').includes('stops after the PA33 audit'));
    assert(!fs.readFileSync(path.join(candidate, 'spec.md'), 'utf8').includes('are deferred'));
    assert(fs.readFileSync(path.join(candidate, 'pa35/reference.mk'), 'utf8').includes('obj/rust/release/cppgm'));
    const handout = fs.readFileSync(path.join(candidate, 'pa34/README.md'), 'utf8');
    if (profile === 'port') {
      assert(handout.includes('F==A==C==D'));
      assert(!handout.includes('A need not equal B'));
      assert(handout.includes('--profile port'));
    } else {
      assert(handout.includes('A need not equal B'));
      assert(!handout.includes('F==A==C==D'));
    }
    const config = JSON.parse(fs.readFileSync(path.join(out, `${name}.config.json`)));
    assert.equal(config.name, original.name);
    assert.equal(config.stateBaseDir, original.stateBaseDir);
    assert.equal(config.stopAfterStage, 'pa35');
    assert.deepEqual(config.extraStages, ['pa34', 'pa35']);
    const context = vm.createContext({});
    for (const name of functions) {
      const declaration = ralph.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
      assert(declaration, name);
      vm.runInContext(declaration[0], context);
    }
    const checks = context.normalizeCheckConfig(config.checks, config.testCommand);
    const phases = context.normalizePhaseConfig(config.phases, checks);
    for (const phase of phases) {
      for (const stage of ['pa33', 'pa34', 'pa35']) {
        const active = phase.checks.map(name => checks.find(check => check.name === name)).filter(check =>
          (!check.onlyStages?.length || check.onlyStages.includes(stage)) && !check.excludeStages?.includes(stage));
        const earlier = new Set();
        for (const check of active) {
          for (const dependency of check.dependsOn) assert(earlier.has(dependency), `${stage}/${phase.name}/${check.name}: missing ${dependency}`);
          earlier.add(check.name);
        }
        if (stage === 'pa33') {
          const originalPhase = original.phases.find(p => p.name === phase.name);
          const expected = originalPhase.checks.filter(key => {
            const c = original.checks[key];
            return (!c.onlyStages?.length || c.onlyStages.includes(stage)) && !c.excludeStages?.includes(stage);
          });
          assert.deepEqual(active.map(c => c.name), expected);
        }
      }
      for (const templates of [phase.promptTemplates, phase.goalTemplates]) {
        for (const stage of ['pa34', 'pa35']) {
          const contents = fs.readFileSync(path.join(out, `${config.name}.${templates[stage]}.md`), 'utf8');
          assert(contents.includes('{{modelValidation}}'));
          assert(!contents.includes('@PROFILE@'));
          if (templates === phase.goalTemplates) assert(contents.length < 2400);
        }
      }
    }
    if (profile === 'student') {
      assert(config.checks.referencePrior.command.startsWith('make test-report-through-pa33'));
      for (const stage of [8, 32, 33]) {
        assert(config.checks.referencePrior.command.includes(`make -C pa${stage} test-debuginfo`));
      }
      assert(!config.checks.referencePrior.command.includes('reference_bootstrap.py course'));
    } else {
      assert(config.checks.referencePrior.command.includes('reference_bootstrap.py course'));
    }
    for (const [key, stage] of [['referenceObjects', 'pa34'], ['referenceProof', 'pa34'],
      ['referencePerf', 'pa35'], ['referenceFinal', 'pa35']]) {
      assert.equal(config.checks[key].targetStage, stage, `${key} must bind its literal command to a stage`);
    }
    assert(config.checks.referenceFinalBootstrap.command.includes('--profile student'));
    assert(config.checks.referenceProof.command.includes(`--profile ${profile}`));
    assert(config.checks.referenceFinal.command.includes('obj/rust/release/cppgm'));
    if (profile === 'port') {
      const manifest = JSON.parse(fs.readFileSync(path.join(out, 'control/manifest.json')));
      assert(manifest.protected['AGENTS.md']);
      assert(manifest.protected['pa35/scripts/check.pl']);
      assert.deepEqual(manifest.oracle_tools, { fixture: 'hash' });
      assert.equal(fs.readFileSync(path.join(out, 'control/manifest.json'), 'utf8'),
        fs.readFileSync(path.join(out, 'candidate/scripts/clone/manifest.json'), 'utf8'));
    }
    const refused = spawnSync('python3', command, { cwd: repo, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert(refused.stderr.includes('new staging directory'));
    fs.writeFileSync(path.join(course, 'scripts/rust_course.json'), JSON.stringify({ course: 'cpp-selfhost' }));
    const mixed = [...command];
    mixed[mixed.indexOf('--out') + 1] = path.join(temporary, 'mixed-track');
    const rejected = spawnSync('python3', mixed, { cwd: repo, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert(rejected.stderr.includes('long-lived rust-course'));
    assert(!fs.existsSync(path.join(temporary, 'mixed-track')));
  });
}
