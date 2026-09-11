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

for (const scenario of ["active-exit", "native-continuation", "native-isolation", "native-private-write", "transport-retry", "blocked", "missing", "verify-error", "exhausted", "restart", "reopened", "interactive-request"]) {
  test(`native Codex goal subprocess: ${scenario}`, async (t) => {
    const privateWrite = scenario === "native-private-write";
    const isolated = scenario === "native-isolation" || privateWrite;
    if (isolated && (!process.env.XDG_RUNTIME_DIR || spawnSync("bwrap",["--version"]).status !== 0)) {
      return t.skip("requires bubblewrap and a user systemd manager");
    }
    const root = await fs.mkdtemp(path.join(privateWrite ? os.homedir() : os.tmpdir(),"ralph-native-goal-"));
    t.after(() => fs.rm(root,{recursive:true,force:true}));
    const privateRoot=path.join(root,"storage");
    if (privateWrite) await fs.mkdir(privateRoot,{mode:0o700});
    const workdir=path.join(privateWrite ? privateRoot : root,"work"), remote=path.join(root,"remote.git");
    const codexDir=path.join(root,"codex"), provider=path.join(root,"codex.cjs");
    const trace=path.join(privateWrite ? codexDir : root,"trace.jsonl"), goalFile=path.join(privateWrite ? codexDir : root,"goal.json");
    const stateBaseDir=path.join(root,"state"), stateDir=path.join(stateBaseDir,"goal-test-fake-high");
    await fs.mkdir(path.join(workdir,"pa1"),{recursive:true});
    await fs.mkdir(path.join(codexDir,"sessions"),{recursive:true});
    await fs.writeFile(path.join(workdir,"pa1","README.md"),"fixture\n");
    for(const args of [["init","-q"],["config","user.email","test@example.invalid"],["config","user.name","Test"],["add","."],["commit","-qm","fixture"]]) execFileSync("git",args,{cwd:workdir});
    execFileSync("git",["init","--bare","-q",remote]);
    execFileSync("git",["remote","add","origin",remote],{cwd:workdir});
    execFileSync("git",["push","-qu","origin","HEAD"],{cwd:workdir});
    const providerSettings={scenario:scenario==="restart"?"exhausted":scenario,workdir,codexDir,trace,goalFile,stateDir};
    await fs.writeFile(provider, fakeCodexSource(providerSettings),{mode:0o755});
    const checkCounter=path.join(root,"check-runs");
    const config=path.join(root,"config.json");
    await fs.writeFile(config,JSON.stringify({name:"goal-test",provider:"codex",model:"fake",reasoningEffort:"high",
      workdir,useExistingWorkdir:true,stateBaseDir,codexPath:provider,loopGoalsEnabled:true,freshThreadPerTurn:true,
      eventLogScope:"run",maxTurns:2,initialStage:"pa1",additionalDirectories:privateWrite?[]:[root],
      resourceLimits:isolated?{enabled:true,memoryMax:"512M",cleanupTimeoutSec:0.2}:false,
      sessionIsolation:privateWrite?{enabled:true,privateWriteDir:privateRoot}:isolated,
      checks:{verify:{command:(scenario==="restart"?`printf check >> '${checkCounter}' && `:"")+(privateWrite?"printf check > /tmp/check-scratch && ":"")+"echo '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) ====='",required:true}},
      phases:[{name:"audit",runWhenChecksPass:true,checks:["verify"]}]}));
    const runOptions={encoding:"utf8",timeout:25000,
      env:{...process.env,RALPH_CONFIG:config,CODEX_HOME:codexDir,RALPH_RESOURCE_LIMITS:isolated?"1":"0",RALPH_SESSION_ISOLATION:isolated?"1":"0",RALPH_CODEX_INCOMPLETE_TASK_RETRY_MAX:"2",RALPH_PROVIDER_TRANSIENT_RETRY_INITIAL_MS:"1"}};
    const run=spawnSync(process.execPath,[path.resolve("ralph.js")],runOptions);
    const succeeds=["active-exit","native-continuation","native-isolation","native-private-write","transport-retry"].includes(scenario);
    assert.equal(run.status,succeeds?0:1,run.stdout+"\n"+run.stderr);
    if (privateWrite) {
      assert.equal(await fs.readFile(path.join(privateRoot,"tmp","check-scratch"),"utf8"),"check");
      assert.equal(await fs.readFile(path.join(privateRoot,"tmp","provider-scratch"),"utf8"),"provider");
    }
    const traces=(await fs.readFile(trace,"utf8")).trim().split("\n").map(JSON.parse);
    const invocations=traces.filter(r=>r.kind==="exec");
    if (privateWrite) assert.match(invocations[0].input, /Storage: checkout and scratch share .*Ralph state is read-only\./s);
    assert.equal(invocations.length,["active-exit","transport-retry"].includes(scenario)?2:["exhausted","restart"].includes(scenario)?3:1);
    assert.equal(traces.filter(r=>r.method==="thread/start").length,1,"incomplete work resumes even with freshThreadPerTurn");
    assert.equal(traces.filter(r=>r.method==="thread/goal/set").length,1,"never reset or forcibly complete the model's goal");
    if(scenario==="active-exit") {
      assert.match(invocations[1].input,/Continue the active loop goal/);
      assert.doesNotMatch(invocations[1].input,/Clean up `audit`/);
      assert.ok(invocations.every(r=>r.threadId===threadId));
    }
    if (scenario.startsWith("native-")) {
      assert.ok(traces.some(r=>r.kind==="child-survived"), "background process survives the native turn boundary");
      assert.equal(traces.filter(r=>r.method==="thread/resume").length,1);
    }
    const state=JSON.parse(await fs.readFile(path.join(stateDir,"state.json"),"utf8"));
    assert.equal(state.turnsCompleted,succeeds||scenario==="reopened"?1:0);
    assert.equal(state.activePhase,succeeds?null:"audit");
    const events=(await fs.readFile(path.join(stateDir,"events","run.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(events.filter(r=>r.eventType==="ralph.prompt").every(r=>r.turnNumber===1));
    assert.equal(events.some(r=>r.eventType==="ralph.goal"&&r.event.action==="complete"),succeeds);
    if (scenario.startsWith("native-")) {
      assert.equal(events.filter(r=>r.eventType==='ralph.turn-failed').length,0);
      assert.equal(events.filter(r=>r.eventType==='turn.completed').length,1);
      const command=events.find(r=>r.eventType==='item.completed' && r.event?.item?.id==='poll');
      assert.equal(command.event.item.exit_code,2);
      assert.equal(command.event.item.session_id,4430);
      assert.match(command.event.item.aggregated_output,/TEST SUMMARY: 45 \/ 47/);
      assert.equal(events.filter(r=>r.eventType==='codex.session.token_count').length,2);
      assert.ok(events.some(r=>r.event?.item?.text==='Audit done.'));
    }
    if (scenario === "interactive-request") assert.match(run.stderr,/requires host interaction/);
    if (scenario === "restart") {
      const existingGoal={...JSON.parse(await fs.readFile(goalFile,"utf8")),
        objective:"Original audit objective, not regenerated on restart",tokensUsed:688895,timeUsedSeconds:5706,tokenBudget:900000};
      const entryChecks=await fs.readFile(checkCounter,"utf8");
      const resumeArgs=[path.resolve("ralph.js"),"--continue","--reuse-last-checks"];
      // A failed lookup or stopped goal must not fall back to creating a new goal.
      for (const [providerScenario,storedGoal,expected] of [
        ["verify-error",existingGoal,/verification unavailable/],
        ["native-continuation",null,/missing or mismatched goal/],
        ["native-continuation",{...existingGoal,threadId:"wrong-thread"},/missing or mismatched goal/],
        ["native-continuation",{...existingGoal,status:"blocked"},/goal is blocked/],
      ]) {
        await fs.writeFile(goalFile,JSON.stringify(storedGoal));
        await fs.writeFile(provider,fakeCodexSource({...providerSettings,scenario:providerScenario,checkCounter}));
        const failed=spawnSync(process.execPath,resumeArgs,runOptions);
        assert.equal(failed.status,1,failed.stdout+failed.stderr);
        assert.match(failed.stdout+failed.stderr,expected);
        assert.deepEqual(JSON.parse(await fs.readFile(goalFile,"utf8")),storedGoal);
        assert.equal(await fs.readFile(checkCounter,"utf8"),entryChecks,"resume reuses entry checks, even on failure");
      }
      await fs.writeFile(goalFile,JSON.stringify(existingGoal));
      await fs.writeFile(provider,fakeCodexSource({...providerSettings,scenario:"native-continuation",checkCounter}));
      const resumed=spawnSync(process.execPath,resumeArgs,runOptions);
      assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);
      assert.match(resumed.stdout,/Preserving existing Codex loop goal/);
      const resumedTrace=(await fs.readFile(trace,"utf8")).trim().split("\n").map(JSON.parse);
      for (const method of ["thread/start","thread/goal/clear","thread/goal/set"]) {
        assert.equal(resumedTrace.filter(r=>r.method===method).length,1,`${method} must not repeat on resume`);
      }
      const resumedExecs=resumedTrace.filter(r=>r.kind==="exec");
      assert.equal(resumedExecs.length,invocations.length+1);
      assert.deepEqual(resumedExecs.at(-1).goal,existingGoal,"objective, creation time, budget and usage are all preserved");
      assert.equal(resumedExecs.at(-1).entryChecks,entryChecks,"no entry checks before the resumed model turn");
      const resumedState=JSON.parse(await fs.readFile(path.join(stateDir,"state.json"),"utf8"));
      assert.equal(resumedState.turnsCompleted,1);
      const resumedEvents=(await fs.readFile(path.join(stateDir,"events","run.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
      const resumedGoal=resumedEvents.find(r=>r.eventType==="ralph.goal"&&r.event.action==="resume");
      assert.deepEqual(resumedGoal.event.goal,existingGoal);
      assert.ok(resumedEvents.filter(r=>r.eventType==="ralph.prompt").every(r=>r.turnNumber===1));
    }
  });
}

function fakeCodexSource(settings) {
  return `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {execFileSync,spawn}=require('node:child_process');
const {scenario,workdir,codexDir,trace,goalFile,stateDir,checkCounter}=${JSON.stringify(settings)};
const native=scenario.startsWith('native-');
const threadId=${JSON.stringify(threadId)};
const emit=x=>console.log(JSON.stringify(x));
const history=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\\n').map(JSON.parse):[];
const log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n');
const getGoal=()=>fs.existsSync(goalFile)?JSON.parse(fs.readFileSync(goalFile,'utf8')):null;
const saveGoal=g=>fs.writeFileSync(goalFile,JSON.stringify(g));
const session=path.join(codexDir,'sessions','rollout-'+threadId+'.jsonl');
const record=(type,data={})=>fs.appendFileSync(session,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type,...data}})+'\\n');
const response=payload=>fs.appendFileSync(session,JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload})+'\\n');
const notify=(method,params)=>emit({method,params:{threadId,...params}});
const end=(text,turnId)=>{
 fs.appendFileSync(session,JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}})+'\\n');
 record('task_complete',{turn_id:turnId,last_agent_message:text});
 notify('turn/completed',{turn:{id:turnId,status:'completed',error:null}});
};
async function runTurn(r) {
 if(scenario==='native-private-write') {
  require('node:assert/strict').throws(()=>fs.writeFileSync(path.join(stateDir,'forbidden'),'bad'),e=>e.code==='EROFS');
  fs.writeFileSync('/tmp/provider-scratch','provider');
 }
 const input=r.params.input.map(x=>x.text??'').join('\\n');
 const attempt=history().filter(x=>x.kind==='exec').length;
 log({kind:'exec',args:process.argv.slice(2),threadId,input,pid:process.pid,goal:getGoal(),
  entryChecks:checkCounter?fs.readFileSync(checkCounter,'utf8'):null});
 const turnId='attempt-'+attempt;
 record('task_started',{turn_id:turnId});notify('turn/started',{turn:{id:turnId,status:'inProgress'}});
 emit({id:r.id,result:{turn:{id:turnId,status:'inProgress'}}});
 if(!attempt)fs.writeFileSync(path.join(workdir,'evidence.json'),'partial audit evidence\\n');
 if(scenario==='interactive-request') {
  emit({id:1,method:'item/commandExecution/requestApproval',params:{threadId,turnId}});return;
 }
 if(scenario==='transport-retry'&&!attempt) {
  notify('error',{willRetry:false,error:{message:'request timed out'}});return;
 }
 if(scenario==='exhausted'||(scenario==='active-exit'&&!attempt)) {
  end('Audit remains active. Evidence and review records are unresolved.',turnId);
  setTimeout(()=>process.exit(0),20);return;
 }
 let finalTurnId=turnId;
 if(native) {
  response({type:'function_call',name:'exec_command',call_id:'command',arguments:JSON.stringify({cmd:'make test-pa12'})});
  response({type:'function_call_output',call_id:'command',output:JSON.stringify({session_id:4430,output:'started'})});
  record('token_count',{info:{total_token_usage:{input_tokens:100,output_tokens:20,cached_input_tokens:40}}});
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  process.on('SIGTERM',()=>{child.kill();process.exit(0);});
  end('Audit remains active.',turnId);
  await new Promise(resolve=>setTimeout(resolve,2500));
  process.kill(child.pid,0);log({kind:'child-survived',pid:child.pid,host:process.pid});
  finalTurnId='continuation';record('task_started',{turn_id:finalTurnId});
  notify('turn/started',{turn:{id:finalTurnId,status:'inProgress'}});
  response({type:'function_call',name:'write_stdin',call_id:'poll',arguments:JSON.stringify({session_id:4430,chars:''})});
  response({type:'function_call_output',call_id:'poll',output:JSON.stringify({exit_code:2,output:'===== TEST SUMMARY: 45 / 47 TESTS PASSED ====='})});
  record('token_count',{info:{total_token_usage:{input_tokens:180,output_tokens:30,cached_input_tokens:60}}});
 }
 if(scenario==='blocked')saveGoal({...getGoal(),status:'blocked'});
 else if(scenario==='missing')saveGoal(null);
 else saveGoal({...getGoal(),status:'complete'});
 record('thread_goal_updated',{goal:getGoal()});
 for(const args of [['add','evidence.json'],['commit','-qm','audit evidence']])execFileSync('git',args,{cwd:workdir});
 end('Audit done.',finalTurnId);
}
(async()=>{
 if(process.argv.includes('app-server')) {
  for await(const line of readline.createInterface({input:process.stdin})) {
   const r=JSON.parse(line);log(r);if(r.id==null)continue;
   let result={};
   if(r.method==='thread/start')result={thread:{id:threadId}};
   if(r.method==='thread/resume')result={thread:{id:threadId,status:{type:'idle'}}};
   if(r.method==='turn/start') {await runTurn(r);continue;}
   if(r.method==='thread/goal/clear')saveGoal(null);
   if(r.method==='thread/goal/set') {
    if(r.params.status==='complete') {emit({id:r.id,error:{message:'Ralph must not force completion'}});continue;}
    const g={...r.params,createdAt:Date.now()/1000,tokensUsed:0,timeUsedSeconds:0};saveGoal(g);record('thread_goal_updated',{goal:g});result={goal:g};
   }
   if(r.method==='thread/goal/get') {
    if(scenario==='verify-error') {emit({id:r.id,error:{message:'verification unavailable'}});continue;}
    if(scenario==='reopened'&&history().filter(x=>x.method==='thread/goal/get').length>2)saveGoal({...getGoal(),status:'active'});
    result={goal:getGoal()};
   }
   emit({id:r.id,result});
  } return;
 }
 throw new Error('Native goals must use app-server, not codex exec');
})();
`;
}
