import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "../ralph-viz/turn-lifecycle.js";

const lifecycle = globalThis.RALPH_TURN_LIFECYCLE;

test("reconnect notices and terminal transport failures are classified narrowly", () => {
  for (const message of ["Reconnecting... 2/5 (request timed out)", "Reconnecting… 5/5 (connection reset)"]) {
    assert.equal(lifecycle.isCodexReconnectNotice({type:"error",message}), true);
  }
  for (const message of ["Reconnecting... 6/5", "Reconnecting... 0/5", "Invalid API key", "request timed out"]) {
    assert.equal(lifecycle.isCodexReconnectNotice({type:"error",message}), false);
  }
  assert.equal(lifecycle.isCodexReconnectNotice({type:"turn.failed",message:"Reconnecting... 2/5"}), false);
  for (const message of ["request timed out", "stream disconnected before completion", "error sending request", "ECONNRESET", "Selected model is at capacity"]) {
    assert.equal(lifecycle.isCodexTransientProviderMessage(message), true, message);
  }
  for (const message of ["401 Unauthorized", "Invalid API key", "model not found", "Permission denied", "command timed out"]) {
    assert.equal(lifecycle.isCodexTransientProviderMessage(message), false, message);
  }
});

for (const scenario of ["reconnect-success", "terminal-retry", "eof-retry", "process-retry", "exhausted", "auth"]) {
  test(`Codex subprocess recovery: ${scenario}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-codex-recovery-"));
    t.after(() => fs.rm(root, {recursive:true,force:true}));
    const workdir = path.join(root, "work");
    const remote = path.join(root, "remote.git");
    const trace = path.join(root, "trace.jsonl");
    const provider = path.join(root, "codex.cjs");
    const stateBaseDir = path.join(root, "state");
    const stateDir = path.join(stateBaseDir, "recovery-gpt-6-astra-high");
    await fs.mkdir(path.join(workdir, "pa1"), {recursive:true});
    await fs.mkdir(path.join(root,"codex"), {recursive:true});
    await fs.writeFile(path.join(workdir, "pa1", "README.md"), "fixture\n");
    for (const args of [["init","-q"], ["config","user.email","test@example.invalid"],
      ["config","user.name","Test"], ["add","."], ["commit","-qm","fixture"]]) {
      execFileSync("git", args, {cwd:workdir});
    }
    execFileSync("git", ["init","--bare","-q",remote]);
    execFileSync("git", ["remote","add","origin",remote], {cwd:workdir});
    execFileSync("git", ["push","-qu","origin","HEAD"], {cwd:workdir});
    await fs.writeFile(provider, `#!/usr/bin/env node
const fs = require('node:fs');
const trace = ${JSON.stringify(trace)};
const scenario = ${JSON.stringify(scenario)};
(async () => {
  for await (const chunk of process.stdin) {}
  const count = fs.existsSync(trace) ? fs.readFileSync(trace,'utf8').trim().split('\\n').length : 0;
  fs.appendFileSync(trace, JSON.stringify({args:process.argv.slice(2)})+'\\n');
  const emit = event => console.log(JSON.stringify(event));
  emit({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
  emit({type:'turn.started'});
  if (scenario==='auth') { emit({type:'error',message:'401 Unauthorized: invalid API key'}); return; }
  if ((scenario==='terminal-retry' && !count) || scenario==='exhausted') {
    emit({type:'turn.failed',error:{message:'request timed out'}}); return;
  }
  if (scenario==='process-retry' && !count) { console.error('error sending request'); process.exitCode=1; return; }
  if ((scenario==='eof-retry' && !count) || scenario==='reconnect-success') {
    emit({type:'error',message:'Reconnecting... 2/5 (request timed out)'});
    if (scenario==='eof-retry') return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  emit({type:'item.completed',item:{id:'reply',type:'agent_message',text:'Recovered and completed'}});
  emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:10}});
})();
`, {mode:0o755});
    const config = path.join(root, "config.json");
    await fs.writeFile(config, JSON.stringify({
      name:"recovery", provider:"codex", model:"gpt-6-astra", reasoningEffort:"high",
      workdir, useExistingWorkdir:true, stateBaseDir, codexPath:provider,
      loopGoalsEnabled:false, freshThreadPerTurn:false, eventLogScope:"run", maxTurns:2,
      initialStage:"pa1", resourceLimits:false, sessionIsolation:false,
      checks:{verify:{command:"echo '===== ALL TESTS PASSED SUCCESSFULLY! (1/1) ====='",required:true}},
      phases:[{name:"audit",runWhenChecksPass:true,checks:["verify"]}],
    }));
    const run = spawnSync(process.execPath, [path.resolve("ralph.js")], {
      cwd:path.resolve("."), encoding:"utf8", timeout:20_000,
      env:{...process.env, RALPH_CONFIG:config, CODEX_HOME:path.join(root,"codex"),
        RALPH_RESOURCE_LIMITS:"0", RALPH_SESSION_ISOLATION:"0",
        RALPH_PROVIDER_TRANSIENT_RETRY_MAX:"2", RALPH_PROVIDER_TRANSIENT_RETRY_INITIAL_MS:"1",
        RALPH_PROVIDER_TRANSIENT_RETRY_MAX_WAIT_MS:"1"},
    });
    const failure = scenario==='exhausted' || scenario==='auth';
    assert.equal(run.status, failure ? 1 : 0, `${run.stdout}\n${run.stderr}`);
    const invocations = (await fs.readFile(trace,"utf8")).trim().split("\n");
    assert.equal(invocations.length, scenario==='exhausted' ? 3 : scenario.endsWith('retry') ? 2 : 1);
    const events = (await fs.readFile(path.join(stateDir,"events","run.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
    const failed = events.filter(event=>event.eventType==='ralph.turn-failed');
    assert.equal(failed.length, scenario==='exhausted' ? 3 : scenario==='reconnect-success' ? 0 : 1);
    const state = JSON.parse(await fs.readFile(path.join(stateDir,"state.json"),"utf8"));
    if (failure) {
      assert.equal(state.activeTurn.status,"failed");
      assert.ok(Date.parse(state.activeTurn.endedAt)>=Date.parse(state.activeTurn.startedAt));
      assert.equal(state.turnsCompleted,0);
      assert.equal(state.activePhase,"audit","failed attempts keep their resumable phase");
    } else {
      assert.equal(state.turnsCompleted,1,"retry does not consume an extra Ralph turn");
      assert.equal(state.activePhase,null);
      assert.ok(events.some(event=>event.eventType==='turn.completed'));
    }
    assert.ok(events.filter(event=>['ralph.prompt','ralph.turn-failed'].includes(event.eventType)).every(event=>event.turnNumber===1));
  });
}
