import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { augmentSourceResponsibilityProgress, parseSourceResponsibilities } from "../ralph-viz/source-responsibilities.js";

const execFileAsync = promisify(execFile);
const header = "cpp_source\trust_owner\tstatus\n";

async function browser() {
  const context = vm.createContext({ state: { progressBestCache: new Map() } });
  for (const [file, binding] of [
    ["entry-dedupe.js", "ENTRY_DEDUPE=RALPH_ENTRY_DEDUPE"],
    ["turn-lifecycle.js", "TURN_LIFECYCLE=RALPH_TURN_LIFECYCLE"],
    ["test-status-summary.js", "TEST_STATUS_SUMMARY=RALPH_TEST_STATUS_SUMMARY"],
    ["test-progress-evidence.js", "TEST_PROGRESS_EVIDENCE=RALPH_TEST_PROGRESS_EVIDENCE"],
    ["test-command-provenance.js", "TEST_COMMAND_PROVENANCE=RALPH_TEST_COMMAND_PROVENANCE"],
  ]) {
    vm.runInContext(await fs.readFile(new URL(`../ralph-viz/${file}`, import.meta.url), "utf8"), context);
    vm.runInContext(`const ${binding};`, context);
  }
  const app = await fs.readFile(new URL("../ralph-viz/app.js", import.meta.url), "utf8");
  for (const match of app.matchAll(/^(?:async )?function [\s\S]*?^\}/gm)) vm.runInContext(match[0], context);
  return context;
}

function records(stage = "pa33", passed = 158) {
  const testStatus = { targetStage: stage, command: `make test-${stage}`,
    testsPassed: passed, testsTotal: 158, allTestsPassed: passed === 158,
    stages: [{ name: stage, passed, total: 158, status: passed === 158 ? "pass" : "fail" }] };
  return [{ turnNumber: 494, threadId: "parent", recordedAt: "2026-10-28T00:00:00Z",
    eventType: "ralph.phase-status", event: { action: "turn-start",
      phaseStatus: { stage, phase: "audit", testStatus } } }];
}

function sourceRecord(passed = 319) {
  return { turnNumber: 494, recordedAt: "2026-10-28T01:00:00Z", eventType: "ralph.source-progress",
    event: { sourceProgress: { stage: "pa33", current: { passed, total: 408 },
      start: { passed: 284, total: 408 } } } };
}

test("source census requires exact inventory, explicit completion and named owners", () => {
  const sources = ["a.cpp", "b.cpp", "c.cpp"];
  const text = header + "a.cpp\tdev/a.rs\tcomplete\nb.cpp\tdev/b.rs\tpending; previously complete\nc.cpp\t\tcomplete\n";
  const census = parseSourceResponsibilities(text, sources);
  assert.equal(census.complete, 1);
  assert.equal(census.total, 3);
  assert.equal(parseSourceResponsibilities(text, ["a.cpp"]), null);
  assert.equal(parseSourceResponsibilities(text + "a.cpp\tdev/a.rs\tcomplete\n", sources), null);
  assert.equal(parseSourceResponsibilities(text.replace("dev/a.rs", "../a.rs"), sources), null);
  assert.equal(parseSourceResponsibilities(text.replace("a.cpp\tdev/a.rs\tcomplete\n", ""), sources,
    { historical: true }).complete, 0);
});

test("PA33 combines tests and reviews in the standard bar; other stages stay unchanged", async () => {
  const b = await browser();
  const progress = b.buildAgentTestProgressState([...records(), sourceRecord()]).latest;
  assert.equal(progress.current.passed, 477);
  assert.equal(progress.current.total, 566);
  assert.equal(progress.start.passed, 442);
  assert.equal(progress.best.passed, 477);
  assert.equal(progress.status, "running");
  const model = b.RALPH_TEST_STATUS_SUMMARY.buildTurnProgressModel(progress);
  const html = b.dockProgressBarHtml({}, progress, model);
  assert.match(html, /start 442/);
  assert.match(html, /current 477/);
  assert.match(html, /best 477/);
  assert.match(html, /566 total/);
  assert.doesNotMatch(html, /source responsibilities/);
  assert.equal(b.buildAgentTestProgressState(records()).latest.current.total, 158);
  assert.equal(b.buildAgentTestProgressState([...records("pa32"), sourceRecord()]).latest.current.total, 158);
});

test("failed tests and reopened responsibilities cannot yield a full bar", async () => {
  const b = await browser();
  const failed = b.buildAgentTestProgressState([...records("pa33", 150), sourceRecord(408)]).latest;
  assert.equal(failed.current.passed, 558);
  assert.notEqual(failed.status, "pass");
  const progress = b.buildAgentTestProgressState([...records(), sourceRecord(319), sourceRecord(300)]).latest;
  assert.equal(progress.current.passed, 458);
  assert.equal(progress.best.passed, 477);
  const complete = b.buildAgentTestProgressState([...records(), sourceRecord(408)]).latest;
  assert.equal(complete.current.passed, 566);
  assert.equal(complete.status, "pass");
});

test("a newer exact clone report replaces an older suite count without masking later failures", async () => {
  const b = await browser();
  const source = sourceRecord();
  source.event.sourceProgress.tests = { passed: 170, total: 170, recordedAt: "2026-10-28T00:30:00Z" };
  const progress = b.buildAgentTestProgressState([...records(), source]).latest;
  assert.equal(progress.current.passed, 489);
  assert.equal(progress.current.total, 578);
  assert.equal(progress.start.total, 578);
  const later = records("pa33", 150);
  later[0].recordedAt = "2026-10-28T00:45:00Z";
  const failed = b.buildAgentTestProgressState([...later, source]).latest;
  assert.equal(failed.current.passed, 469);
  assert.equal(failed.testProgress.total, 158);
});

test("live evidence refreshes without altering history and uses a committed turn baseline", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-source-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "docs/port"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts/clone"), { recursive: true });
  await fs.mkdir(path.join(root, "dev"));
  const map = path.join(root, "docs/port/source-map.tsv");
  const state = path.join(root, "state.json");
  await fs.writeFile(path.join(root, "dev/a.rs"), "// owner\n");
  const manifest = JSON.stringify({ source_responsibilities: ["a.cpp"], stages: { pa33: ["tests/a.t"] } });
  await fs.writeFile(path.join(root, "scripts/clone/manifest.json"), manifest);
  const artifacts = path.join(root, "artifacts");
  await fs.mkdir(path.join(artifacts, "results"), { recursive: true });
  await fs.writeFile(path.join(root, "scripts/clone/settings.json"), JSON.stringify({ artifacts }));
  const report = { stage: "pa33", manifest_sha256: createHash("sha256").update(manifest).digest("hex"),
    results: [{ case: "tests/a.t", passed: true }, { case: "tests/added.t", passed: false }] };
  const reportPath = path.join(artifacts, "results/pa33.json");
  await fs.writeFile(reportPath, JSON.stringify(report));
  await fs.writeFile(state, JSON.stringify({ activeStage: "pa33", activeTurn: { turnNumber: 494 } }));
  await fs.writeFile(map, header + "a.cpp\t\tpending\n");
  for (const args of [["init", "-q"], ["add", "docs/port/source-map.tsv"],
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"]]) {
    await execFileAsync("git", args, { cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-27T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-27T00:00:00Z" } });
  }
  await fs.writeFile(map, header + "a.cpp\tdev/a.rs\tcomplete\n");
  const events = records();
  const before = JSON.stringify(events);
  await augmentSourceResponsibilityProgress(events, root, state);
  assert.equal(JSON.stringify(events.slice(0, -1)), before);
  assert.equal(events.at(-1).event.sourceProgress.current.passed, 1);
  assert.equal(events.at(-1).event.sourceProgress.start.passed, 0);
  assert.equal(events.at(-1).event.sourceProgress.tests.passed, 1);
  assert.equal(events.at(-1).event.sourceProgress.tests.total, 2);
  await fs.writeFile(reportPath, JSON.stringify({ ...report, manifest_sha256: "old-baseline" }));
  await fs.writeFile(map, header + "a.cpp\tdev/a.rs\tpending\n");
  const fresh = records();
  await augmentSourceResponsibilityProgress(fresh, root, state);
  assert.equal(fresh.at(-1).event.sourceProgress.current.passed, 0);
  assert.equal(fresh.at(-1).event.sourceProgress.tests, null);
  await fs.writeFile(map, header + "a.cpp\tdev/missing.rs\tcomplete\n");
  const missing = records();
  await augmentSourceResponsibilityProgress(missing, root, state);
  assert.equal(missing.length, 1);
  await fs.writeFile(state, JSON.stringify({ activeStage: "pa34", activeTurn: { turnNumber: 495 } }));
  const advanced = records();
  await augmentSourceResponsibilityProgress(advanced, root, state);
  assert.equal(advanced.length, 1);
});
