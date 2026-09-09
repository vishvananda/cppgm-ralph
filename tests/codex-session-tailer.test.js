import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexSessionTailer } from "../codex-session-events.js";

const record = (text, timestamp) => JSON.stringify({ timestamp, type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }) + "\n";

test("flush joins an existing poll and drains final records appended during it", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-tailer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "sessions"));
  const file = path.join(dir, "sessions", "rollout-thread.jsonl");
  await fs.writeFile(file, record("first", "2026-09-09T00:00:00Z"));
  const seen = [];
  let entered, release;
  const blocked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const tailer = createCodexSessionTailer({ codexDir: dir, threadId: "thread", pollMs: 60_000,
    onEvent: async event => {
      seen.push(event.item.text);
      if (seen.length === 1) { entered(); await gate; }
    } });
  t.after(() => tailer.stop());
  tailer.start();
  await blocked;
  await fs.appendFile(file, record("final", "2026-09-09T00:00:01Z"));
  let flushed = false;
  const flushing = tailer.flush().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushed, false);
  release();
  await flushing;
  assert.deepEqual(seen, ["first", "final"]);
});

test("polling a partial JSON or UTF-8 write doesn't lose or duplicate the message", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-tailer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "sessions"));
  const file = path.join(dir, "sessions", "rollout-thread.jsonl");
  const bytes = Buffer.from(record("finished ✓", "2026-09-09T00:00:00Z"));
  const split = bytes.indexOf(Buffer.from("✓")) + 1;
  await fs.writeFile(file, bytes.subarray(0, split));
  const seen = [];
  const tailer = createCodexSessionTailer({ codexDir: dir, threadId: "thread", onEvent: e => seen.push(e) });
  t.after(() => tailer.stop());
  await tailer.flush();
  assert.equal(seen.length, 0);
  await fs.appendFile(file, bytes.subarray(split));
  await tailer.flush();
  await tailer.flush();
  assert.deepEqual(seen.map(e => e.item.text), ["finished ✓"]);
});
