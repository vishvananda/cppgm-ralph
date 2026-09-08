import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCodexGoalComplete, codexSessionTaskCompletion, parseCodexToolGoalStatus,
  requiresCodexGoalCompletion } from "../codex-goal-completion.js";

const threadId = "11111111-1111-4111-8111-111111111111";
const start = Date.parse("2026-09-08T20:26:40Z");
const event = (ms, type, payload = {}) => ({ timestamp: new Date(start + ms).toISOString(),
  type: "event_msg", payload: { type, ...payload } });
const goal = (status) => event(0, "thread_goal_updated", { goal: { threadId, status } });
const complete = (ms = 1000) => event(ms, "task_complete", { last_agent_message: "The audit remains open." });
const options = { threadId, startedAtMs: start, requireGoalCompletion: true, nowMs: start + 90_000 };

test("only an explicit native goal completion satisfies the goal gate", () => {
  for (const status of ["complete", "completed"]) assert.doesNotThrow(() => assertCodexGoalComplete({threadId, status}, threadId));
  assert.throws(() => assertCodexGoalComplete({threadId, status:"active"}, threadId), e => e.codexIncompleteTask === true);
  for (const status of ["blocked", "paused", "budget_limited", "unknown", undefined]) {
    assert.throws(() => assertCodexGoalComplete({threadId, status}, threadId), e => e.codexIncompleteTask === false);
  }
  assert.throws(() => assertCodexGoalComplete({threadId:"another",status:"complete"}, threadId), /different thread/);
  assert.equal(requiresCodexGoalCompletion({threadId,status:"active"},"codex"),true);
  assert.equal(requiresCodexGoalCompletion({provider:"ralph-portable"},"codex"),false);
  assert.equal(requiresCodexGoalCompletion(null,"codex"),false);
  assert.equal(requiresCodexGoalCompletion({threadId},"claude"),false);
});

test("a final message with an active goal waits for continuation, never counts as success", () => {
  const records = [goal("active"), complete()];
  assert.equal(codexSessionTaskCompletion(records, {...options,nowMs:start+4000}).status,"pending");
  assert.equal(codexSessionTaskCompletion(records, options).status,"incomplete");
  assert.equal(codexSessionTaskCompletion([complete()], options).status,"incomplete", "truncated goal history is not success");
  assert.equal(codexSessionTaskCompletion(records, {...options,requireGoalCompletion:false}).status,"complete");
  assert.equal(codexSessionTaskCompletion([goal("blocked"),complete()], options).status,"goal_stopped");
});

test("native continuations and interruptions are not mistaken for a completed goal", () => {
  const records = [goal("active"), complete(), event(1055,"task_started")];
  assert.equal(codexSessionTaskCompletion(records,options).status,"pending");
  records.push(event(1070,"turn_aborted",{reason:"interrupted"}));
  assert.equal(codexSessionTaskCompletion(records,options).status,"pending");
  records.push(event(1100,"thread_goal_updated",{goal:{threadId,status:"complete"}}),complete(1200));
  assert.equal(codexSessionTaskCompletion(records,options).status,"complete");
  assert.equal(codexSessionTaskCompletion(records,{...options,nowMs:start+1300}).status,"pending", "allow final session writes to settle");
});

test("goal outputs support direct JSON and Code Mode text blocks, with thread validation", () => {
  const json=JSON.stringify({goal:{threadId,status:"complete"}});
  for (const output of [json, [{type:"input_text",text:json}], [{type:"input_text",text:`Script completed\nOutput:\n${json}`}]] ) {
    assert.equal(parseCodexToolGoalStatus(output,threadId),"complete");
    const records=[goal("active"), {timestamp:new Date(start+500).toISOString(), type:"response_item",
      payload:{type:"custom_tool_call_output",output}},complete()];
    assert.equal(codexSessionTaskCompletion(records,options).status,"complete");
  }
  assert.equal(parseCodexToolGoalStatus(json,"different"),null);
  assert.equal(parseCodexToolGoalStatus("Goal completed",threadId),null);
  assert.equal(codexSessionTaskCompletion([event(1000,"task_complete",{error:{codex_error_info:"usage_limit_exceeded"}})],options).status,"usage_limit");
});

for (const scenario of ["active-exit", "native-continuation", "blocked", "missing", "verify-error", "exhausted", "reopened"]) {
  test(`native Codex goal subprocess: ${scenario}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),"ralph-native-goal-"));
    t.after(() => fs.rm(root,{recursive:true,force:true}));
    const workdir=path.join(root,"work"), remote=path.join(root,"remote.git");
    const codexDir=path.join(root,"codex"), provider=path.join(root,"codex.cjs");
    const trace=path.join(root,"trace.jsonl"), goalFile=path.join(root,"goal.json");
    const stateBaseDir=path.join(root,"state"), stateDir=path.join(stateBaseDir,"goal-test-fake-high");
    await fs.mkdir(path.join(workdir,"pa1"),{recursive:true});
    await fs.mkdir(path.join(codexDir,"sessions"),{recursive:true});
    await fs.writeFile(path.join(workdir,"pa1","README.md"),"fixture\n");
    for(const args of [["init","-q"],["config","user.email","test@example.invalid"],["config","user.name","Test"],["add","."],["commit","-qm","fixture"]]) execFileSync("git",args,{cwd:workdir});
    execFileSync("git",["init","--bare","-q",remote]);
    execFileSync("git",["remote","add","origin",remote],{cwd:workdir});
    execFileSync("git",["push","-qu","origin","HEAD"],{cwd:workdir});
    await fs.writeFile(provider, fakeCodexSource({scenario,workdir,codexDir,trace,goalFile}),{mode:0o755});
    const config=path.join(root,"config.json");
    await fs.writeFile(config,JSON.stringify({name:"goal-test",provider:"codex",model:"fake",reasoningEffort:"high",
      workdir,useExistingWorkdir:true,stateBaseDir,codexPath:provider,loopGoalsEnabled:true,freshThreadPerTurn:true,
      eventLogScope:"run",maxTurns:2,initialStage:"pa1",resourceLimits:false,sessionIsolation:false,
      checks:{verify:{command:"echo '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) ====='",required:true}},
      phases:[{name:"audit",runWhenChecksPass:true,checks:["verify"]}]}));
    const run=spawnSync(process.execPath,[path.resolve("ralph.js")],{encoding:"utf8",timeout:25000,
      env:{...process.env,RALPH_CONFIG:config,CODEX_HOME:codexDir,RALPH_RESOURCE_LIMITS:"0",RALPH_SESSION_ISOLATION:"0",RALPH_CODEX_INCOMPLETE_TASK_RETRY_MAX:"2"}});
    const succeeds=["active-exit","native-continuation"].includes(scenario);
    assert.equal(run.status,succeeds?0:1,run.stdout+"\n"+run.stderr);
    const traces=(await fs.readFile(trace,"utf8")).trim().split("\n").map(JSON.parse);
    const invocations=traces.filter(r=>r.kind==="exec");
    assert.equal(invocations.length,scenario==="active-exit"?2:scenario==="exhausted"?3:1);
    assert.equal(traces.filter(r=>r.method==="thread/start").length,1,"incomplete work resumes even with freshThreadPerTurn");
    assert.equal(traces.filter(r=>r.method==="thread/goal/set").length,1,"never reset or forcibly complete the model's goal");
    if(scenario==="active-exit") {
      assert.match(invocations[1].input,/Continue the active loop goal/);
      assert.doesNotMatch(invocations[1].input,/Clean up `audit`/);
      assert.ok(invocations.every(r=>r.args.includes(threadId)));
    }
    const state=JSON.parse(await fs.readFile(path.join(stateDir,"state.json"),"utf8"));
    assert.equal(state.turnsCompleted,succeeds||scenario==="reopened"?1:0);
    assert.equal(state.activePhase,succeeds?null:"audit");
    const events=(await fs.readFile(path.join(stateDir,"events","run.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(events.filter(r=>r.eventType==="ralph.prompt").every(r=>r.turnNumber===1));
    assert.equal(events.some(r=>r.eventType==="ralph.goal"&&r.event.action==="complete"),succeeds);
  });
}

function fakeCodexSource(settings) {
  return `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {execFileSync}=require('node:child_process');
const {scenario,workdir,codexDir,trace,goalFile}=${JSON.stringify(settings)};
const threadId=${JSON.stringify(threadId)};
const emit=x=>console.log(JSON.stringify(x));
const history=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\\n').map(JSON.parse):[];
const log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n');
const getGoal=()=>fs.existsSync(goalFile)?JSON.parse(fs.readFileSync(goalFile,'utf8')):null;
const saveGoal=g=>fs.writeFileSync(goalFile,JSON.stringify(g));
const session=path.join(codexDir,'sessions','rollout-'+threadId+'.jsonl');
const record=(type,data={})=>fs.appendFileSync(session,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type,...data}})+'\\n');
(async()=>{
 if(process.argv.includes('app-server')) {
  for await(const line of readline.createInterface({input:process.stdin})) {
   const r=JSON.parse(line);log(r);if(r.id==null)continue;
   let result={};
   if(r.method==='thread/start')result={thread:{id:threadId}};
   if(r.method==='thread/goal/clear')saveGoal(null);
   if(r.method==='thread/goal/set') {
    if(r.params.status==='complete') {emit({id:r.id,error:{message:'Ralph must not force completion'}});continue;}
    const g={...r.params,createdAt:Date.now()/1000,tokensUsed:0,timeUsedSeconds:0};saveGoal(g);record('thread_goal_updated',{goal:g});result={goal:g};
   }
   if(r.method==='thread/goal/get') {
    if(scenario==='verify-error') {emit({id:r.id,error:{message:'verification unavailable'}});continue;}
    if(scenario==='reopened'&&history().filter(x=>x.method==='thread/goal/get').length>1)saveGoal({...getGoal(),status:'active'});
    result={goal:getGoal()};
   }
   emit({id:r.id,result});
  } return;
 }
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const attempt=history().filter(x=>x.kind==='exec').length;
 log({kind:'exec',args:process.argv.slice(2),input});
 record('task_started',{turn_id:'attempt-'+attempt});
 emit({type:'thread.started',thread_id:threadId});emit({type:'turn.started'});
 if(!attempt)fs.writeFileSync(path.join(workdir,'evidence.json'),'partial audit evidence\\n');
 const end=(text)=>{record('task_complete',{turn_id:'attempt-'+attempt,last_agent_message:text});emit({type:'item.completed',item:{id:'reply-'+attempt,type:'agent_message',text}});emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:10}});};
 if(scenario==='exhausted'||(scenario==='active-exit'&&!attempt)) {
  end('Audit remains active. Evidence and review records are unresolved.');
  record('task_started',{turn_id:'continuation'});record('turn_aborted',{turn_id:'continuation',reason:'interrupted'});return;
 }
 if(scenario==='native-continuation') {
  end('Audit remains active.');record('task_started',{turn_id:'continuation'});
  await new Promise(r=>setTimeout(r,3500));
 }
 if(scenario==='blocked')saveGoal({...getGoal(),status:'blocked'});
 else if(scenario==='missing')saveGoal(null);
 else saveGoal({...getGoal(),status:'complete'});
 record('thread_goal_updated',{goal:getGoal()});
 for(const args of [['add','evidence.json'],['commit','-qm','audit evidence']])execFileSync('git',args,{cwd:workdir});
 end('Audit done.');
 if(scenario==='native-continuation')await new Promise(r=>setTimeout(r,10000));
})();
`;
}
