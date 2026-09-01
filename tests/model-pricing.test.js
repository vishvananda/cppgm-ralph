import assert from "node:assert/strict";
import test from "node:test";

import "../ralph-viz/model-pricing.js";
import {
  attributeShapeUsageModels,
  mergeCumulativeThreadUsageEntries,
} from "../ralph-viz/server.js";

const pricing = globalThis.RALPH_MODEL_PRICING;

test("mixed-model usage is priced before aggregation", () => {
  const sol = pricing.attributeUsage({
    input_tokens: 2_546_390,
    cached_input_tokens: 2_405_632,
    output_tokens: 23_669,
    reasoning_output_tokens: 14_303,
    total_tokens: 2_570_059,
  }, "gpt-5.6-sol");
  const luna = pricing.attributeUsage({
    input_tokens: 13_011_163,
    cached_input_tokens: 12_554_240,
    output_tokens: 95_521,
    reasoning_output_tokens: 50_090,
    total_tokens: 13_106_684,
  }, "gpt-5.6-luna");

  const combined = pricing.addUsage(sol, luna);
  const breakdown = pricing.costBreakdown(combined);

  assert.equal(breakdown.length, 2);
  assert.equal(breakdown.find((entry) => entry.model === "gpt-5.6-sol").cost_usd, 2.616676);
  assert.equal(breakdown.find((entry) => entry.model === "gpt-5.6-luna").cost_usd, 0.4570946);
  assert.ok(Math.abs(combined.cost_usd - 3.0737706) < 1e-12);

  const incorrectlyFlattenedCost = pricing.estimateCost({
    ...combined,
    cost_usd: 0,
    model_usage: undefined,
  }, "gpt-5.6-sol");
  assert.ok(Math.abs(incorrectlyFlattenedCost - 14.044041) < 1e-12);
});

test("model breakdown merges repeated usage for the same model", () => {
  const first = pricing.attributeUsage({ input_tokens: 100, output_tokens: 10 }, "gpt-5.6-luna");
  const second = pricing.attributeUsage({ input_tokens: 200, output_tokens: 20 }, "gpt-5.6-luna");
  const combined = pricing.addUsage(first, second);

  assert.equal(combined.model_usage.length, 1);
  assert.deepEqual(combined.model_usage[0], {
    model: "gpt-5.6-luna",
    input_tokens: 300,
    cached_input_tokens: 0,
    output_tokens: 30,
    reasoning_output_tokens: 0,
    total_tokens: 330,
    cost_usd: 0.000096,
  });
});

test("shape usage preserves child pricing in the aggregate and turn", () => {
  const rootUsage = {
    input_tokens: 2_546_390,
    cached_input_tokens: 2_405_632,
    output_tokens: 23_669,
    total_tokens: 2_570_059,
  };
  const childUsage = {
    input_tokens: 13_011_163,
    cached_input_tokens: 12_554_240,
    output_tokens: 95_521,
    total_tokens: 13_106_684,
  };
  const aggregate = pricing.addUsage(rootUsage, childUsage);
  const shapeUsage = {
    runCount: 1,
    usage: aggregate,
    runs: [{
      threadIds: ["root", "child"],
      threadUsages: [
        { threadId: "root", usage: rootUsage },
        { threadId: "child", usage: childUsage },
      ],
      turnUsages: [{ turnNumber: 1, usage: aggregate }],
      usage: aggregate,
    }],
  };
  const events = [
    { threadId: "root", turnNumber: 1, event: {} },
    {
      threadId: "root",
      turnNumber: 1,
      event: {
        item: {
          type: "subagent",
          id: "child",
          agent_thread_id: "child",
          parent_thread_id: "root",
          model: "gpt-5.6-luna",
        },
      },
    },
  ];

  const priced = attributeShapeUsageModels(shapeUsage, events, "gpt-5.6-sol");

  assert.ok(Math.abs(priced.usage.cost_usd - 3.0737706) < 1e-12);
  assert.ok(Math.abs(priced.runs[0].turnUsages[0].usage.cost_usd - 3.0737706) < 1e-12);
  assert.deepEqual(
    priced.usage.model_usage.map((entry) => entry.model),
    ["gpt-5.6-luna", "gpt-5.6-sol"],
  );
});

test("shape usage prices mixed root phase agents with their own models", () => {
  const fableUsage = {
    input_tokens: 1000,
    cached_input_tokens: 500,
    output_tokens: 100,
    total_tokens: 1100,
  };
  const lunaUsage = {
    input_tokens: 1000,
    cached_input_tokens: 500,
    output_tokens: 100,
    total_tokens: 1100,
  };
  const aggregate = pricing.addUsage(fableUsage, lunaUsage);
  const shapeUsage = {
    runCount: 1,
    usage: aggregate,
    runs: [{
      threadIds: ["fable-root", "luna-root"],
      threadUsages: [
        { threadId: "fable-root", usage: { ...fableUsage, input_tokens: 5000, total_tokens: 5100 } },
        { threadId: "luna-root", usage: lunaUsage },
      ],
      turnUsages: [
        { turnNumber: 1, usage: { ...fableUsage, total_cost_usd: 0.01234 } },
        { turnNumber: 2, usage: lunaUsage },
      ],
      usage: aggregate,
    }],
  };
  const phaseStatus = (threadId, turnNumber, provider, model) => ({
    eventType: "ralph.phase-status",
    threadId,
    turnNumber,
    event: {
      agentProfile: { provider, model, reasoningEffort: "max" },
    },
  });
  const events = [
    phaseStatus("fable-root", 1, "claude", "claude-fable-5"),
    phaseStatus("luna-root", 2, "codex", "gpt-5.6-luna"),
  ];

  const priced = attributeShapeUsageModels(shapeUsage, events, "claude-fable-5");

  assert.ok(Math.abs(priced.usage.cost_usd - 0.01257) < 1e-12);
  assert.deepEqual(
    priced.usage.model_usage.map(({ model, cost_usd }) => ({ model, cost_usd })),
    [
      { model: "claude-fable-5", cost_usd: 0.01234 },
      { model: "gpt-5.6-luna", cost_usd: 0.00023 },
    ],
  );
  assert.equal(priced.runs[0].turnUsages[0].usage.cost_usd, 0.01234);
  assert.equal(priced.runs[0].turnUsages[1].usage.cost_usd, 0.00023);
});

test("incremental cumulative thread usage replaces the cached counter", () => {
  const byThread = new Map([["thread", {
    input_tokens: 1000,
    output_tokens: 100,
    total_tokens: 1100,
  }]]);

  mergeCumulativeThreadUsageEntries(byThread, [{
    threadId: "thread",
    usage: {
      input_tokens: 1200,
      output_tokens: 120,
      total_tokens: 1320,
    },
  }]);

  assert.equal(byThread.get("thread").input_tokens, 1200);
  assert.equal(byThread.get("thread").total_tokens, 1320);
});
