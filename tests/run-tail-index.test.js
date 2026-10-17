import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("tail index retains byte ranges, hydrates selected turns, and handles partial writes and resets", async t => {
  const previousCwd = process.cwd();
  const previousCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-tail-index-"));
  t.after(async () => {
    process.chdir(previousCwd);
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await fs.rm(root, {recursive:true, force:true});
  });
  const eventsDir = path.join(root, ".ralph", "fixture", "events");
  await fs.mkdir(eventsDir, {recursive:true});
  const file = path.join(eventsDir, "run.jsonl");
  const record = (turnNumber, eventType, event) => ({
    recordedAt: `2026-10-17T00:${String(turnNumber).padStart(2,"0")}:00.000Z`,
    threadId: "fixture", turnNumber, eventType, event: {type:eventType, ...event},
  });
  const log = [];
  for (let turn = 1; turn <= 24; turn++) {
    log.push(record(turn, "ralph.phase-status", {action:"turn-start",
      agentProfile:{model:"gpt-6.1-sol"}, phaseStatus:{stage:"pa1", phase:"implement"}}));
    log.push(record(turn, "ralph.prompt", {prompt:`Turn ${turn} ✓`}));
    log.push(record(turn, "codex.command.completed", {item:{id:`cmd-${turn}`,
      type:"command_execution", aggregated_output:"x".repeat(512*1024)}}));
  }
  await fs.writeFile(file, log.map(JSON.stringify).join("\n")+"\n");
  // Old payload caches must never be parsed or mistaken for the new index.
  await fs.mkdir(path.join(root,".ralph","fixture","usage-cache"), {recursive:true});
  await fs.writeFile(path.join(root,".ralph","fixture","usage-cache","run.structure.json"), "obsolete");
  process.chdir(root);
  process.env.CODEX_HOME = path.join(root,"codex");
  const url = pathToFileURL(path.join(previousCwd,"ralph-viz","server.js"));
  url.searchParams.set("tail-index-test",String(Date.now()));
  const { requestHandler } = await import(url.href);
  const request = async (turns=2) => {
    const response = {writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
    await requestHandler({method:"GET",headers:{host:"localhost"},
      url:`/api/run/fixture%2Frun?codex=tail&tailTurns=${turns}&usage=skip`},response);
    assert.equal(response.status,200);
    return response.body.events;
  };
  let events = await request();
  assert.deepEqual([...new Set(events.map(e=>e.turnNumber))],[23,24]);
  assert.equal(events.find(e=>e.eventType==="ralph.prompt").event.prompt,"Turn 23 ✓");
  const cacheFile = path.join(root,".ralph","fixture","usage-cache","run.structure-v2.json");
  const rawIndex = await fs.readFile(cacheFile,"utf8");
  assert(rawIndex.length < 20000, `index retained payloads: ${rawIndex.length}`);
  const index = JSON.parse(rawIndex);
  assert.equal(index.phaseEvents.length,24);
  assert.equal(index.entries.length,log.length);
  assert.equal(index.events,undefined);
  events = await request(20);
  assert.deepEqual([...new Set(events.map(e=>e.turnNumber))],Array.from({length:20},(_,i)=>i+5));

  const next = Buffer.from(JSON.stringify(record(25,"ralph.prompt",{prompt:"Next turn ✓"}))+"\n");
  const split = next.indexOf(Buffer.from("✓"))+1;
  await fs.appendFile(file,next.subarray(0,split));
  assert.equal((await request()).some(e=>e.turnNumber===25),false);
  await fs.appendFile(file,next.subarray(split));
  events = await request();
  assert.equal(events.filter(e=>e.turnNumber===25).length,1);
  assert.equal(events.find(e=>e.turnNumber===25).event.prompt,"Next turn ✓");

  const replacement = JSON.stringify(record(1,"ralph.prompt",{prompt:"Run reset"}))+"\n";
  const previousSize = (await fs.stat(file)).size;
  await fs.writeFile(file,replacement+" ".repeat(previousSize-Buffer.byteLength(replacement)));
  // Ensure a distinct mtime even on filesystems with coarse timestamps.
  const stamp = new Date(Date.now()+2000);
  await fs.utimes(file,stamp,stamp);
  events = await request();
  assert.deepEqual([...new Set(events.map(e=>e.turnNumber))],[1]);
  assert.equal(events[0].event.prompt,"Run reset");
});
