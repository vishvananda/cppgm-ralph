import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { augmentLatestTestStatusFromLog } from "../ralph-viz/server.js";

async function browser() {
  const context = vm.createContext({state:{progressBestCache:new Map()}});
  for (const [file,binding] of [
    ["entry-dedupe.js","ENTRY_DEDUPE=RALPH_ENTRY_DEDUPE"],
    ["turn-lifecycle.js","TURN_LIFECYCLE=RALPH_TURN_LIFECYCLE"],
    ["test-status-summary.js","TEST_STATUS_SUMMARY=RALPH_TEST_STATUS_SUMMARY"],
    ["test-progress-evidence.js","TEST_PROGRESS_EVIDENCE=RALPH_TEST_PROGRESS_EVIDENCE"],
    ["test-command-provenance.js","TEST_COMMAND_PROVENANCE=RALPH_TEST_COMMAND_PROVENANCE"],
  ]) {
    vm.runInContext(await fs.readFile(new URL(`../ralph-viz/${file}`,import.meta.url),"utf8"),context);
    vm.runInContext(`const ${binding};`,context);
  }
  const app=await fs.readFile(new URL("../ralph-viz/app.js",import.meta.url),"utf8");
  for(const match of app.matchAll(/^(?:async )?function [\s\S]*?^\}/gm)) vm.runInContext(match[0],context);
  return context;
}
function fixture(turn=315) {
  const testStatus={recordedAt:"2026-10-17T03:38:03Z",command:"make inception CXX=g++ CPPGM_HOST_CXX=g++",
    targetStage:"pa34",testsPassed:0,testsTotal:1,allTestsPassed:false,exitCode:null,
    firstFailureLine:"pa34Inception failed",stages:[]};
  const checks=[
    {name:"fileAudit",kind:"generic",required:true,passed:true,exitCode:0,
      command:"perl scripts/cppgm_file_audit.pl --stage pa34 --paths dev"},
    {name:"pa34HostThrough33",kind:"test",required:true,passed:true,exitCode:0,
      command:"make test-report-through-pa33",testStatus:{command:"make test-report-through-pa33",
        targetStage:"pa34",testsPassed:6675,testsTotal:6675,allTestsPassed:true,stages:[]}},
    {name:"pa34SelfThroughPa5",kind:"generic",required:true,passed:false,exitCode:2,
      command:"make -C pa34 test-through-pa5 CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++"},
    {name:"pa34PptokenInception",kind:"generic",required:true,passed:false,skipped:true,exitCode:null,
      command:"make -C pa34 compare-pptoken-inception CXX=../dev/cppgm++ CPPGM_HOST_CXX=g++"},
    {name:"pa34Inception",kind:"generic",required:true,primary:true,passed:false,skipped:true,exitCode:null,
      command:testStatus.command},
  ];
  const phaseStatus={stage:"pa34",phase:"implement",primaryCheck:checks.at(-1),checks,testStatus};
  const record=(eventType,event,second="05")=>({turnNumber:turn,threadId:"root",
    recordedAt:`2026-10-17T03:38:${second}Z`,eventType,event});
  return {testStatus,checks,phaseStatus,record,records:[
    record("ralph.phase-status",{action:"turn-start",phaseStatus}),
    record("ralph.test-status",{testStatus}),
  ]};
}

test("a skipped generic inception result cannot inherit the prior host test log",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"ralph-generic-status-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,"last-test.log"),"===== ALL TESTS PASSED SUCCESSFULLY! (6675 / 6675) =====\n");
  await fs.mkdir(path.join(root,"checks"));
  const selfLog=path.join(root,"checks","last-pa34SelfThroughPa5.log");
  await fs.writeFile(selfLog,"pa1 tests: PASS (20/20)\npa2 tests: PASS (30/30)\n");
  await fs.utimes(selfLog,new Date("2026-10-17T03:38:03Z"),new Date("2026-10-17T03:38:03Z"));
  const f=fixture();
  await augmentLatestTestStatusFromLog(f.records,path.join(root,"events","run.jsonl"));
  assert.equal(f.records[1].event.testStatus.testsTotal,1);
  assert.equal(f.records[1].event.testStatus.testsPassed,0);
  assert.equal(f.records[1].event.testStatus.allTestsPassed,false);
  assert.equal(f.checks[1].testStatus.testsTotal,6675);
  assert.deepEqual(f.checks[2].testCounts,{passed:50,total:50,observedOnly:true});
  assert.equal(f.checks[4].testCounts,undefined);
  await fs.writeFile(selfLog,"pa1 tests: PASS (999/999)\n");
  await fs.utimes(selfLog,new Date("2026-10-17T03:38:10Z"),new Date("2026-10-17T03:38:10Z"));
  await augmentLatestTestStatusFromLog(f.records,path.join(root,"events","run.jsonl"));
  assert.equal(f.checks[2].testCounts.total,50,"a newer log cannot rewrite an older check snapshot");
});

test("PA34 counts five checks and nests prerequisite test totals",async()=>{
  const b=await browser(),f=fixture();
  const progress=b.buildAgentTestProgressState(f.records).latest;
  assert.equal(progress.stage,"pa34");
  assert.equal(progress.unit,"checks");
  assert.equal(progress.current.total,5);
  assert.equal(progress.current.passed,2);
  assert.equal(progress.checks[1].counts.total,6675);
  assert.equal(b.mergeProgressBestCache("run",progress).progress,progress,
    "recorded check outcomes must not inherit browser estimates");
  f.testStatus.testsTotal=6675;
  f.testStatus.testsPassed=6675;
  f.testStatus.allTestsPassed=true;
  assert.equal(b.buildAgentTestProgressState(f.records).latest.current.total,5,
    "older inflated API results must not contaminate check progress");
  const model=b.RALPH_TEST_STATUS_SUMMARY.buildTurnProgressModel(progress);
  const html=b.dockProgressBarHtml(f.phaseStatus,progress,model);
  assert.match(html,/5 checks/);
  assert.match(html,/6,675\/6,675 tests/);
  assert.match(html,/phase-check-skipped/);
  assert.doesNotMatch(html,/6,675 total/);
});

test("manual command feeds cannot replace recorded phase-check outcomes",async()=>{
  const b=await browser(),f=fixture();
  f.records.push(f.record("item.completed",{item:{type:"command_execution",id:"self",
    command:f.checks[2].command,exit_code:0,
    aggregated_output:"pa1 tests: PASS (20/20)\npa2 tests: PASS (30/30)\n"}},"10"));
  f.records.push(f.record("item.completed",{item:{type:"command_execution",id:"prior",
    command:f.checks[1].command,exit_code:2,aggregated_output:""}},"11"));
  const progress=b.buildAgentTestProgressState(f.records).latest;
  assert.equal(progress.current.passed,2);
  assert.equal(progress.current.total,5);
  assert.equal(progress.checks[1].passed,true);
  assert.equal(progress.checks[2].passed,false);
});

test("new harness results advance checks and retain nested test counts",async()=>{
  const b=await browser(),f=fixture();
  const checked=structuredClone(f.phaseStatus);
  checked.checks[2].passed=true;
  checked.checks[2].exitCode=0;
  checked.checks[2].testCounts={passed:50,total:50};
  f.records.push(f.record("ralph.phase-status",{action:"checked",phaseStatus:checked},"12"));
  const progress=b.buildAgentTestProgressState(f.records).latest;
  assert.equal(progress.current.passed,3);
  assert.equal(progress.current.total,5);
  assert.equal(progress.start.passed,2);
  assert.equal(progress.checks[2].counts.total,50);
  assert.equal(progress.checks[2].counts.passed,50);
  assert.equal(progress.checks[4].passed,false);
});

test("a later normal test stage keeps its own numeric suite progress",async()=>{
  const b=await browser(),f=fixture(1);
  const status={targetStage:"pa35",command:"make test-pa35",testsPassed:3,testsTotal:17,
    allTestsPassed:false,stages:[{name:"pa35",total:17,passed:3,status:"fail"}]};
  f.records.push({turnNumber:2,eventType:"ralph.phase-status",recordedAt:"2026-10-17T04:00:00Z",
    event:{phaseStatus:{stage:"pa35",testStatus:status}}});
  assert.equal(b.buildAgentTestProgressState(f.records).latest.current.total,17);
});
