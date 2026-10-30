import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { normalizeProgressModel, mergePublishedAndLocalComparisons } from '../ralph-viz/server.js';

const model = { kind: 'source-files', stage: 'pa33', total: 408 };
const literal = { id: 'literal/run', progressModel: model };

async function browser() {
  const context = vm.createContext({ state: { comparisonRunVisibility: new Map() },
    ASSIGNMENT_LAYOUT: globalThis.RALPH_ASSIGNMENT_LAYOUT,
    fmtInt: String, escapeHtml: String, comparisonRunVisible: () => true });
  const app = await fs.readFile(new URL('../ralph-viz/app.js', import.meta.url), 'utf8');
  for (const name of ['isSourceTranslationRun', 'sourceTranslationProgress', 'sourceTranslationChartHtml',
    'comparisonRunOrder', 'defaultCombinedComparisonThrough', 'comparisonSummaryStarted']) {
    const source = app.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, 'm'))?.[0];
    assert(source, name); vm.runInContext(source, context);
  }
  return context;
}

function progress(turn, passed, stage = 'pa33', total = 408) {
  return { turn, stage, current: { passed, total } };
}

test('source progress requires an explicit valid model, not a run-name heuristic', () => {
  assert.deepEqual(normalizeProgressModel(model), model);
  for (const value of [null, { ...model, total: -1 }, { ...model, total: '408' },
    { ...model, stage: 'unknown' }, { ...model, kind: 'tests' }]) assert.equal(normalizeProgressModel(value), null);
});

test('file history preserves reopening, ignores unrelated test totals, and labels bootstrap separately', async () => {
  const b = await browser();
  const summary = { latestPhaseStatus: { status: { stage: 'pa34' } }, testProgress: {
    byTurn: new Map([[1, progress(1, 0)], [2, progress(2, 6)], [3, progress(3, 4)],
      [4, progress(4, 7, 'pa34', 7)], [5, progress(5, 236, 'pa33', 236)]]) } };
  const source = b.sourceTranslationProgress(summary, literal);
  assert.equal(source.current, 4);
  assert.deepEqual(Array.from(source.points, p => p.passed), [0, 6, 4]);
  assert.equal(source.phase, 'Bootstrap proof');
  const html = b.sourceTranslationChartHtml(summary, literal);
  assert.match(html, /4\/408 reviewed files/);
  assert.match(html, /Turn 2: 6\/408 files/);
  assert.match(html, /Turn 3: 4\/408 files/);
  assert.doesNotMatch(html, /pa33|pa34|NaN|Infinity/);
  assert.equal(b.sourceTranslationChartHtml(summary, { id: 'v5literal-looking-name/run' }), '');
});

test('unknown and zero source observations stay distinct', async () => {
  const b = await browser();
  assert.match(b.sourceTranslationChartHtml({}, literal), /Waiting for the first/);
  assert.match(b.sourceTranslationChartHtml({ testProgress: { byTurn: new Map([[1, progress(1, 0)]]) } }, literal), /0\/408 reviewed files/);
});

test('full checkpoint history survives a two-turn card tail and retains reopened files', async () => {
  const b = await browser();
  const summary = { sourceProgressHistory: [
    { turn: 1, stage: 'pa33', total: 408, passed: 0, action: 'turn-start' },
    { turn: 1, stage: 'pa33', total: 408, passed: 3, action: 'checked' },
    { turn: 2, stage: 'pa33', total: 408, passed: 5, action: 'checked' },
    { turn: 3, stage: 'pa33', total: 408, passed: 4, action: 'checked' },
  ], testProgress: { byTurn: new Map([[3, progress(3, 4)], [4, progress(4, 7)]]) } };
  const source = b.sourceTranslationProgress(summary, literal);
  assert.deepEqual(Array.from(source.points, p => [p.turn, p.passed]), [[0, 0], [1, 3], [2, 5], [3, 4], [4, 7]]);
  assert.equal(source.current, 7);
  const html = b.sourceTranslationChartHtml(summary, literal);
  assert.match(html, /Turn 1: 3\/408 files/);
  const y = html.match(/<polyline[^>]*points="([^"]+)"/)[1].split(' ').map(point => Number(point.split(',')[1]));
  assert(y[0] - y.at(-1) > 30, 'early file completions must not look flat against the entire inventory');
});

test('source translation cannot enter the PA curves or extend their default range to PA33', async () => {
  const b = await browser();
  const comparison = { runs: [{ label: 'native' }, literal], localRunIndices: [0, 1] };
  const rows = Array.from({ length: 35 }, (_, i) => ({ pa: `pa${i + 1}`, runs: [
    i < 3 ? { status: 'partial', cost: 1 } : null,
    i === 32 ? { status: 'partial', cost: 100 } : null,
  ] }));
  assert.deepEqual(Array.from(b.comparisonRunOrder(comparison.runs)), [0]);
  assert.equal(b.defaultCombinedComparisonThrough(comparison, rows), 4);
});

test('comparison merging retains source metadata and assigns no PA milestones', () => {
  const comparison = mergePublishedAndLocalComparisons({ through: 'pa2', runs: [{ spec: 'baseline' }],
    rows: [{ pa: 'pa1', runs: [{ status: 'complete', cost: 1 }] }] }, [{
    runRef: { shape: 'literal' }, comparison: { through: 'pa0', rows: [],
      runs: [{ spec: 'literal', progressModel: model }] },
  }]);
  assert.deepEqual(comparison.runs[1].progressModel, model);
  for (const row of comparison.rows) {
    assert.equal(row.runs[1].status, 'not started');
    assert.equal(row.runs[1].cost, 0);
  }
});

test('live catalog and comparison preserve the configured source model without PA33 cost attribution', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ralph-source-viewer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shape = 'literal-gpt-6.1-sol-high';
  const eventsDir = path.join(root, '.ralph', shape, 'events');
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(path.join(root, 'literal.config.json'), JSON.stringify({
    name: 'literal', model: 'gpt-6.1-sol', reasoningEffort: 'high', assignmentLayout: 'v5', progressModel: model,
  }));
  const records = [0, 2, 4, 3, 5, 6].map((passed, index) => ({
    recordedAt: new Date(Date.now() + index * 1000).toISOString(), turnNumber: index + 1, threadId: 'fixture',
    eventType: 'ralph.phase-status', event: { action: 'turn-start',
      phaseStatus: { stage: 'pa33', phase: 'implement', allRequiredPassed: false,
        testStatus: { targetStage: 'pa33', testsPassed: passed, testsTotal: 408 } } },
  }));
  await fs.writeFile(path.join(eventsDir, 'run.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  // A pre-history cache must upgrade for this source run without invalidating
  // other runs' large structural indexes.
  const cacheDir = path.join(root, '.ralph', shape, 'usage-cache');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, 'run.structure-v2.json'), JSON.stringify({
    version: 2, fileSize: 0, trailingBytes: '', entries: [], phaseEvents: [],
  }));
  const published = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ through: 'pa2', runs: [{ spec: 'baseline' }],
      rows: [{ pa: 'pa1', runs: [{ status: 'complete', cost: 5 }] }] }));
  });
  published.listen(0, '127.0.0.1'); await once(published, 'listening');
  t.after(() => new Promise(resolve => published.close(resolve)));
  const url = new URL('../ralph-viz/server.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http'; import { requestHandler } from ${JSON.stringify(url)};
    const server=http.createServer((req,res)=>requestHandler(req,res).catch(error=>{res.writeHead(500);res.end(error.message)}));
    server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
  `], { cwd: root, env: { ...process.env, CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_PROJECTS_DIR: path.join(root, 'claude'),
    RALPH_VIZ_PUBLISHED_COMPARISON_URL: `http://127.0.0.1:${published.address().port}/` },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode == null) { child.kill(); await once(child, 'exit'); } });
  const [port] = await once(child.stdout, 'data');
  const base = `http://127.0.0.1:${String(port).trim()}`;
  const catalog = await (await fetch(base + '/api/runs')).json();
  assert.deepEqual(catalog.runs[0].progressModel, model);
  const details = await (await fetch(base + '/api/run/' + encodeURIComponent(shape + '/run') +
    '?codex=tail&tailTurns=2&usage=skip')).json();
  assert.deepEqual([...new Set(details.events.map(event => event.turnNumber))], [5, 6]);
  assert.deepEqual(details.sourceProgressHistory.map(point => point.turn), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(details.sourceProgressHistory.map(point => point.passed), [0, 2, 4, 3, 5, 6]);
  const next = structuredClone(records.at(-1));
  next.turnNumber = 7;
  next.event.phaseStatus.testStatus.testsPassed = 8;
  await fs.appendFile(path.join(eventsDir, 'run.jsonl'), JSON.stringify(next) + '\n');
  const detailsUrl = base + '/api/run/' + encodeURIComponent(shape + '/run') + '?codex=tail&tailTurns=2&usage=skip';
  const appended = await (await fetch(detailsUrl)).json();
  assert.deepEqual(appended.sourceProgressHistory.map(point => point.turn), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(appended.sourceProgressHistory.at(-1).passed, 8);
  const reset = structuredClone(records[0]);
  reset.event.phaseStatus.testStatus.testsPassed = 1;
  await fs.writeFile(path.join(eventsDir, 'run.jsonl'), JSON.stringify(reset) + '\n');
  const resetDetails = await (await fetch(detailsUrl)).json();
  assert.deepEqual(resetDetails.sourceProgressHistory.map(point => point.passed), [1]);
  const response = await fetch(base + '/api/comparison?run=' + encodeURIComponent(shape + '/run'));
  assert.equal(response.status, 200);
  const comparison = await response.json();
  const source = comparison.runs.findIndex(run => run.progressModel?.kind === 'source-files');
  assert.equal(source, 1);
  assert.equal(comparison.through, 'pa2', 'transport PA33 must not extend the PA axis');
  for (const row of comparison.rows) {
    assert.equal(row.runs[source].status, 'not started');
    assert.equal(row.runs[source].cost, 0);
  }
});
