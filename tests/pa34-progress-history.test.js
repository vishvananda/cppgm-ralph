import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { progressObservationFromSessionOutput, scanCodexSessionProgressObservations } from "../ralph-viz/server.js";

const selfCommand = "make -C pa34 test-through-pa5 CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++";
const five = { pa1:true, pa2:true, pa3:true, pa4:true, pa5:true };
const timestamp = "2026-10-17T06:00:00Z";
const record = payload => JSON.stringify({ timestamp, type:"response_item", payload }) + "\n";
const call = (id,cmd) => record({type:"function_call",name:"exec_command",call_id:id,arguments:JSON.stringify({cmd})});
const output = (id,text) => record({type:"function_call_output",call_id:id,output:text});
const completed = code => `Process exited with code ${code}\nFinal output:\n`;

test("PA34 reports one result per self-hosted assignment and comparison",()=>{
  const summary=Object.keys(five).map(stage=>`${stage} tests: PASS (20/20)`).join("\n");
  const observation=progressObservationFromSessionOutput(summary,timestamp,selfCommand);
  assert.deepEqual(observation.unitResults,five);
  assert.equal(observation.total,7);
  assert.deepEqual(progressObservationFromSessionOutput("MATCH pptoken: identical",timestamp,
    "make -C pa34 compare-pptoken-inception").unitResults,{pptoken:true});
  assert.deepEqual(progressObservationFromSessionOutput("MATCH cppgm++: identical",timestamp,
    "make inception CXX=g++").unitResults,{inception:true});
  assert.equal(progressObservationFromSessionOutput(summary,timestamp,"make test-report-through-pa33")?.unitResults,undefined);
  assert.equal(progressObservationFromSessionOutput(summary,timestamp,"tail -10 /tmp/unknown.log"),null);
  assert.equal(progressObservationFromSessionOutput(summary,timestamp,"make -C pa34 test-through-pa5 CXX=g++"),null);
});

test("native session history recovers a silent successful ladder and later individual regression",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ralph-pa34-history-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"session.jsonl");
  await fs.writeFile(file,call("self",`${selfCommand} >/tmp/self.log 2>&1`)+output("self",completed(0)));
  const state={};
  const first=await scanCodexSessionProgressObservations(file,0,state);
  assert.deepEqual(first.map(x=>x.unitResults),[five]);
  await fs.appendFile(file,call("regression","make -C pa34 test-pa3 >/tmp/regression.log 2>&1")+
    output("regression",completed(2)));
  const restored=JSON.parse(JSON.stringify(state));
  const later=await scanCodexSessionProgressObservations(file,restored.offset,restored);
  assert.deepEqual(later.map(x=>x.unitResults),[{pa3:false}]);
});

test("a successful sibling command cannot certify a failed self-hosted ladder",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ralph-pa34-batch-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"session.jsonl");
  await fs.writeFile(file,record({type:"custom_tool_call",name:"exec",call_id:"batch",
    input:`text(await tools.exec_command({cmd:${JSON.stringify(selfCommand)}}));\ntext(await tools.exec_command({cmd:"pwd"}));`})+
    record({type:"custom_tool_call_output",call_id:"batch",output:[
      {type:"input_text",text:JSON.stringify({output:"",exit_code:2})},
      {type:"input_text",text:JSON.stringify({output:"/repo",exit_code:0})},
    ]}));
  const observations=await scanCodexSessionProgressObservations(file);
  assert.equal(observations.filter(x=>x.unitResults && Object.values(x.unitResults).some(Boolean)).length,0);
});
