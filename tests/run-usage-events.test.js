import assert from "node:assert/strict";
import test from "node:test";
import { compactRunUsageEvent } from "../run-usage-events.js";
import { turnExecutionDurationEntries } from "../ralph-viz/server.js";

test("usage projection drops transcript payloads while preserving timing, counters and child metadata", () => {
  const text = "large transcript".repeat(10000);
  const record = (eventType,event,second) => ({eventType,turnNumber:1,threadId:"parent",
    recordedAt:`2026-10-17T00:00:${String(second).padStart(2,"0")}Z`,event});
  const usage = {input_tokens:1000,output_tokens:100,total_tokens:1100};
  const records = [
    record("ralph.phase-status",{action:"turn-start",agentProfile:{model:"gpt-6.1-sol"},
      phaseStatus:{stage:"pa1",phase:"audit",allRequiredPassed:false,
        failedRequiredChecks:[{name:"tests",output:text}],checks:[{output:text}]}},0),
    record("ralph.prompt",{prompt:"Implement pa1"},1),
    record("item.started",{item:{id:"cmd",type:"command_execution",command:text}},2),
    record("item.completed",{item:{id:"cmd",type:"command_execution",aggregated_output:text}},4),
    record("item.completed",{item:{id:"child",type:"subagent",agent_thread_id:"child",
      provider:"codex",model:"gpt-6-luna",notification_id:"done",usage,duration_ms:2000,
      prompt:text,result:text}},5),
    record("codex.session.token_count",{usage,counter_scope:"turn",counter_id:"retry"},6),
    record("turn.completed",{usage},7),
  ];
  const projected = records.map(compactRunUsageEvent);
  assert(JSON.stringify(projected).length < JSON.stringify(records).length/100);
  assert.deepEqual(turnExecutionDurationEntries(projected),turnExecutionDurationEntries(records));
  assert.deepEqual(projected[0].event.agentProfile,records[0].event.agentProfile);
  assert.equal(projected[0].event.phaseStatus.failedRequiredChecks.length,1);
  assert.deepEqual(projected[4].event.item.usage,usage);
  assert.equal(projected[4].event.item.notification_id,"done");
  assert.deepEqual(projected[5].event,records[5].event);
  assert.equal(records[3].event.item.aggregated_output,text,"projection must not mutate display events");
});
