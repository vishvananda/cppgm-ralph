import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/entry-dedupe.js";

const { dedupeRichEntries } = globalThis.RALPH_ENTRY_DEDUPE;
const identity = (entry) => entry.id ? `${entry.type}\u0000${entry.id}` : null;
const signature = (entry) => [entry.text, entry.command, entry.output, entry.diff, entry.path]
  .filter(Boolean)
  .join("\u0000");

test("redelivered entries keep the richest copy at first appearance", () => {
  const first = { type: "command", id: "cmd-1", command: "make test" };
  const unrelated = { type: "message", text: "working" };
  const completed = { type: "command", id: "cmd-1", command: "make test", output: "PASS" };

  assert.deepEqual(
    dedupeRichEntries([first, unrelated, completed], identity, signature),
    [completed, unrelated],
  );
});

test("entries without ids and distinct ids remain separate", () => {
  const entries = [
    { type: "message", text: "same" },
    { type: "command", id: "one", command: "true" },
    { type: "command", id: "two", command: "true" },
    { type: "message", text: "same" },
  ];

  assert.deepEqual(dedupeRichEntries(entries, identity, signature), entries);
});
