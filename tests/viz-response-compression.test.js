import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

test("large API responses negotiate gzip, preserve JSON, and honor q=0", async t => {
  const previousCwd = process.cwd();
  const previousCodexHome = process.env.CODEX_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"ralph-viz-gzip-"));
  t.after(async () => {
    process.chdir(previousCwd);
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await fs.rm(root,{recursive:true,force:true});
  });
  const dir = path.join(root,".ralph","fixture","events");
  await fs.mkdir(dir,{recursive:true});
  const text = "A substantial assistant message. ".repeat(3000);
  await fs.writeFile(path.join(dir,"run.jsonl"),JSON.stringify({
    turnNumber:1,threadId:"fixture",recordedAt:"2026-10-17T00:00:00Z",eventType:"item.completed",
    event:{type:"item.completed",item:{id:"message",type:"agent_message",text}},
  })+"\n");
  process.chdir(root);
  process.env.CODEX_HOME = path.join(root,"codex");
  const url = pathToFileURL(path.join(previousCwd,"ralph-viz","server.js"));
  url.searchParams.set("compression-test",String(Date.now()));
  const {requestHandler} = await import(url.href);
  const request = async (encoding, route="/api/run/fixture%2Frun?codex=all&usage=skip") => {
    const res = {req:{headers:{"accept-encoding":encoding}},
      writeHead(status,headers){this.status=status;this.headers=headers;},
      end(body){this.raw=Buffer.from(body);}};
    await requestHandler({method:"GET",url:route,headers:{host:"localhost"}},res);
    assert.equal(res.status,200);
    assert.equal(res.raw.length,res.headers["Content-Length"]);
    return res;
  };
  const plain = await request("");
  const zipped = await request("br, gzip, deflate");
  assert.equal(zipped.headers["Content-Encoding"],"gzip");
  assert.equal(zipped.headers.Vary,"Accept-Encoding");
  assert(zipped.raw.length < plain.raw.length/10);
  assert.deepEqual(JSON.parse(gunzipSync(zipped.raw)),JSON.parse(plain.raw));
  assert.equal(JSON.parse(gunzipSync(zipped.raw)).events[0].event.item.text,text);
  assert.equal((await request("gzip;q=0, br")).headers["Content-Encoding"],undefined);
  assert.equal((await request("gzip","/api/runs")).headers["Content-Encoding"],undefined);
});
