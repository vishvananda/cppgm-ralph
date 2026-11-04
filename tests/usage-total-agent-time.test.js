import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import '../ralph-viz/model-pricing.js';

const app = fs.readFileSync(new URL('../ralph-viz/app.js', import.meta.url), 'utf8');
function browser() {
  const context = vm.createContext({
    MODEL_PRICING: globalThis.RALPH_MODEL_PRICING,
    state: { staticRunSummaries: new Map() },
    staticDataPath: value => value,
    fmtInt: String, fmtUsd: value => `$${value.toFixed(2)}`, escapeHtml: String,
    costEstimateText: () => 'n/a', shapeUsageTurnCost: () => 1,
  });
  for (const name of ['normalizeUsage', 'normalizeShapeUsage', 'shapeUsageTotalAgentDurationMs',
    'preferredUsageSummary', 'usageSummaryText', 'durationText', 'loadStaticRunSummary']) {
    const source = app.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
    assert(source, name); vm.runInContext(source, context);
  }
  return context;
}
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
const run = { id: 'archived/run', label: 'archived', dataPath: 'runs/archived/summary.json' };

test('legacy exports show the graph total including child work, independent of loaded turn cards', async () => {
  const b = browser();
  b.fetchJson = async () => ({ shapeUsage: { usage, durationMs: 1234, runCount: 1,
    runs: [{ turnDurations: [{ durationMs: 100, totalDurationMs: 200 }] }] } });
  b.loadStaticComparison = async () => ({ runs: [{ dataPath: run.dataPath,
    total: { durationMs: 3_600_000, totalDurationMs: 5_400_000 } }] });
  const result = await b.loadStaticRunSummary(run);
  const preferred = b.preferredUsageSummary({ shapeUsage: b.normalizeShapeUsage(result.shapeUsage) });
  assert.equal(preferred.durationMs, 3_600_000);
  assert.equal(preferred.totalDurationMs, 5_400_000);
  const html = b.usageSummaryText(preferred.usage, null, preferred);
  assert.match(html, /1h 0m active \/ 1h 30m total agent time/);
  assert.match(html, /120 uncached tok/);
  assert.equal(await b.loadStaticRunSummary(run), result);
});

test('new explicit export totals work without fetching comparison data', async () => {
  const b = browser();
  b.fetchJson = async () => ({ shapeUsage: { usage, runCount: 1,
    durationMs: 3_600_000, totalDurationMs: 7_200_000 } });
  b.loadStaticComparison = async () => { throw new Error('must not fetch'); };
  const result = await b.loadStaticRunSummary(run);
  assert.equal(b.normalizeShapeUsage(result.shapeUsage).totalDurationMs, 7_200_000);
});

test('missing additive timing remains unknown and zero remains a known total', async () => {
  const b = browser();
  b.fetchJson = async () => ({ shapeUsage: { usage, durationMs: 1000 } });
  b.loadStaticComparison = async () => null;
  const result = await b.loadStaticRunSummary(run);
  const preferred = b.preferredUsageSummary({ shapeUsage: result.shapeUsage });
  assert.equal(preferred.totalDurationMs, null);
  assert.doesNotMatch(b.usageSummaryText(usage, null, preferred), /total agent time/);
  assert.equal(b.shapeUsageTotalAgentDurationMs({ durationMs: 0, totalDurationMs: 0 }), 0);
});
