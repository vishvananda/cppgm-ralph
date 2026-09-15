import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSessionIsolationSpawn, normalizePrivateWriteSettings, parseMountPoints,
  preparePrivateWriteDirectory, validatePrivateWriteDirectory } from "../session-isolation.js";

const isolation = { enabled: true, backend: "bwrap", readOnlyRoot: true, privateTmp: true };
const hasBwrap = process.platform === "linux" && spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "true"]).status === 0;

function fixture(t, base = os.tmpdir()) {
  const directory = fs.mkdtempSync(path.join(base, "ralph-private-write-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "storage");
  const workdir = path.join(root, "checkout");
  const home = path.join(directory, "home");
  const stateDir = path.join(directory, "state");
  const provider = path.join(home, ".codex");
  for (const dir of [root, workdir, stateDir, provider, path.join(home, ".cache"), path.join(home, ".claude")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return { directory, root, workdir, home, stateDir, provider, settings: {
    isolation: { ...isolation, privateWriteDir: root }, workdir, stateDir, home,
    providerDirectories: [provider],
  } };
}

test("private-write configuration is opt-in and fails closed on incompatible settings", () => {
  assert.equal(normalizePrivateWriteSettings(isolation).privateWriteDir, null);
  for (const value of ["relative", "", false, 7]) {
    assert.throws(() => normalizePrivateWriteSettings({ ...isolation, privateWriteDir: value }), /absolute path/);
  }
  for (const patch of [{ enabled: false }, { readOnlyRoot: false }, { privateTmp: false }]) {
    assert.throws(() => normalizePrivateWriteSettings({ ...isolation, ...patch, privateWriteDir: "/some/run" }), /requires Linux isolation/);
  }
  for (const value of [0, -1, 1.5, "10G", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizePrivateWriteSettings({ ...isolation, privateWriteMaxBytes: value }), /positive integer/);
  }
  assert.throws(() => normalizePrivateWriteSettings({ ...isolation, privateWriteMaxBytes: 10 }), /requires privateWriteDir/);
});

test("private storage is persistent, and checkouts/extra write paths cannot escape it", t => {
  const f = fixture(t);
  const layout = preparePrivateWriteDirectory(f.settings);
  fs.writeFileSync(path.join(layout.tmp, "retained"), "evidence");
  preparePrivateWriteDirectory(f.settings);
  assert.equal(fs.readFileSync(path.join(layout.tmp, "retained"), "utf8"), "evidence");
  // Fresh checkouts are allowed, including nonexistent descendants.
  validatePrivateWriteDirectory({ ...f.settings, workdir: path.join(f.root, "new", "checkout") });
  for (const patch of [{ workdir: f.directory }, { workdir: f.root },
    { additionalDirectories: [f.directory] }, { stateDir: path.join(f.root, "state") },
    { stateDir: path.join(f.provider, "ralph-state") },
    { providerDirectories: [f.root] }, { isolation: { ...f.settings.isolation, privateWriteDir: path.join(f.directory, "missing") } }]) {
    assert.throws(() => validatePrivateWriteDirectory({ ...f.settings, ...patch }));
  }
  fs.symlinkSync(f.directory, path.join(f.root, "escape"));
  assert.throws(() => validatePrivateWriteDirectory({ ...f.settings, workdir: path.join(f.root, "escape", "new") }), /must be inside/);
  fs.symlinkSync(path.join(f.directory, "missing"), path.join(f.root, "dangling"));
  assert.throws(() => validatePrivateWriteDirectory({ ...f.settings, workdir: path.join(f.root, "dangling") }));
  fs.rmdirSync(layout.cache);
  fs.symlinkSync(f.directory, layout.cache);
  assert.throws(() => preparePrivateWriteDirectory(f.settings), /must not be a symlink/);
});

test("storage configuration rejects shared roots and reconstructs removed scratch directories", t => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o755);
  assert.throws(() => preparePrivateWriteDirectory(f.settings), /mode 0700/);
  fs.chmodSync(f.root, 0o700);
  const layout = preparePrivateWriteDirectory(f.settings);
  fs.rmdirSync(layout.cache);
  buildSessionIsolationSpawn("true", [], { isolation: f.settings.isolation, privateWriteSettings: f.settings,
    writableDirectories: [f.workdir], home: f.home });
  assert.equal(fs.statSync(layout.cache).isDirectory(), true);
});

test("a requested capacity cannot silently use an ordinary host directory", t => {
  const f = fixture(t);
  assert.throws(() => preparePrivateWriteDirectory({ ...f.settings,
    isolation: { ...f.settings.isolation, privateWriteMaxBytes: 10 * 1024 ** 3 } }), /not mounted/);
  assert.deepEqual(parseMountPoints("1 2 3:4 / /space\\040name rw - ext4 /dev/example rw\n"), ["/space name"]);
});

test("legacy bubblewrap keeps its existing writable-directory and tmpfs behavior", () => {
  const wrapped = buildSessionIsolationSpawn("provider", ["argument"], {
    isolation, cwd: "/work", writableDirectories: ["/work", "/state", "/work"],
    fdFiles: [{ fd: 3, destination: "/tmp/prompt" }],
  });
  assert.equal(wrapped.command, "bwrap");
  assert.ok(wrapped.args.includes("--dev-bind"));
  assert.ok(wrapped.args.includes("--tmpfs"));
  assert.equal(wrapped.args.filter(value => value === "--bind-try").length, 2);
  assert.deepEqual(wrapped.args.slice(-5), ["--chdir", "/work", "--", "provider", "argument"]);
  assert.throws(() => buildSessionIsolationSpawn("provider", [], { isolation, fdFiles: [{ fd: 2, destination: "/tmp/prompt" }] }), /fd >= 3/);
});

test("real private sandbox restricts writes, preserves scratch, and overlays fd prompts", { skip: !hasBwrap }, t => {
  // Outside /tmp so fixtures used for read-only probes remain visible when /tmp is private.
  const f = fixture(t, os.homedir());
  const layout = preparePrivateWriteDirectory(f.settings);
  const readonly = [f.stateDir, path.join(f.home, ".claude"), f.directory];
  for (const dir of readonly) fs.writeFileSync(path.join(dir, "readonly"), "original");
  const promptPath = path.join(f.directory, "prompt");
  fs.writeFileSync(promptPath, "test prompt");
  const fd = fs.openSync(promptPath, "r");
  t.after(() => fs.closeSync(fd));
  const code = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    for (const p of ${JSON.stringify(readonly)}) {
      assert.throws(() => fs.writeFileSync(p + '/readonly', 'bad'), e => e.code === 'EROFS');
      assert.equal(fs.readFileSync(p + '/readonly', 'utf8'), 'original');
    }
    for (const p of ['/tmp', '/var/tmp', '/dev/shm', process.env.XDG_CACHE_HOME,
        ${JSON.stringify(path.join(f.home, ".cache"))}, ${JSON.stringify(f.workdir)}, ${JSON.stringify(f.provider)},
        process.env.RALPH_ARTIFACT_DIR]) fs.writeFileSync(p + '/written', 'ok');
    assert.equal(process.env.TMPDIR, '/tmp');
    assert.equal(process.env.TMP, '/tmp');
    assert.equal(process.env.TEMP, '/tmp');
    assert.equal(fs.readFileSync('/tmp/prompt', 'utf8'), 'test prompt');
    assert.throws(() => fs.writeFileSync('/tmp/prompt', 'bad'), e => e.code === 'EROFS');
    assert.equal(process.env.RALPH_WRITE_DIR, ${JSON.stringify(f.root)});
  `;
  const build = (source, providerDirectories = [f.provider]) => buildSessionIsolationSpawn(process.execPath, ["-e", source], {
    isolation: f.settings.isolation, cwd: f.workdir, home: f.home,
    writableDirectories: [f.workdir], providerDirectories, privateWriteSettings: f.settings,
    fdFiles: [{ fd: 3, destination: "/tmp/prompt" }],
  });
  const first = build(code);
  const run = spawnSync(first.command, first.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd],
    env: { ...process.env, TMPDIR: f.directory, XDG_CACHE_HOME: f.directory } });
  assert.equal(run.status, 0, run.stderr);
  for (const dir of [layout.tmp, layout["var-tmp"], layout.shm, layout.cache, layout.artifacts, f.workdir, f.provider]) {
    assert.equal(fs.readFileSync(path.join(dir, "written"), "utf8"), "ok");
  }
  const second = build(`const fs=require('node:fs'), assert=require('node:assert/strict');
    assert.equal(fs.readFileSync('/tmp/written','utf8'),'ok');
    assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(f.provider, "written"))}, 'bad'), e=>e.code==='EROFS');`, []);
  const check = spawnSync(second.command, second.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd] });
  assert.equal(check.status, 0, check.stderr);
});

test("real bounded filesystem rejects oversize/missing mounts and permits cleanup after ENOSPC", { skip: !hasBwrap }, t => {
  const f = fixture(t, os.homedir());
  const module = new URL("../session-isolation.js", import.meta.url).href;
  const limit = 16 * 1024 ** 2;
  const code = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import {preparePrivateWriteDirectory, validatePrivateWriteDirectory, buildSessionIsolationSpawn} from ${JSON.stringify(module)};
    import {spawnSync} from 'node:child_process';
    const settings=${JSON.stringify(f.settings)};
    fs.chmodSync(settings.isolation.privateWriteDir, 0o700);
    fs.mkdirSync(settings.workdir);
    settings.isolation.privateWriteMaxBytes=${limit / 2};
    assert.throws(()=>preparePrivateWriteDirectory(settings), /exceeds privateWriteMaxBytes/);
    settings.isolation.privateWriteMaxBytes=${limit};
    const layout=preparePrivateWriteDirectory(settings);
    const childCode=\`
      const fs=require('node:fs'), assert=require('node:assert/strict');
      const file=process.env.RALPH_ARTIFACT_DIR+'/large';
      const fd=fs.openSync(file,'w');
      assert.throws(()=>{for(let i=0;i<32;i++)fs.writeSync(fd,Buffer.alloc(1024*1024));}, e=>e.code==='ENOSPC');
      fs.closeSync(fd);
      assert.throws(()=>fs.writeFileSync(process.env.TMPDIR+'/overflow','full'),e=>e.code==='ENOSPC');
      fs.unlinkSync(file);
      fs.writeFileSync(process.env.TMPDIR+'/recovered','cleanup works');
    \`;
    const wrapped=buildSessionIsolationSpawn(process.execPath,['-e',childCode],{
      isolation:settings.isolation,cwd:settings.workdir,home:settings.home,
      writableDirectories:[settings.workdir],privateWriteSettings:settings
    });
    assert.ok(wrapped.args.includes(layout.tmp));
    // Some CI hosts prohibit nested user namespaces. The separate real bind
    // test covers path routing; exercise the real capped filesystem here.
    const run=spawnSync(process.execPath,['-e',childCode],{encoding:'utf8',env:{...process.env,
      RALPH_ARTIFACT_DIR:layout.artifacts,TMPDIR:layout.tmp}});
    assert.equal(run.status,0,run.stderr);
    assert.equal(fs.readFileSync(layout.tmp+'/recovered','utf8'),'cleanup works');
  `;
  const run = spawnSync("bwrap", ["--bind", "/", "/", "--size", String(limit), "--tmpfs", f.root,
    "--", process.execPath, "--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const nested = spawnSync("bwrap", ["--bind", "/", "/", "--size", String(limit), "--tmpfs", f.root,
    "--tmpfs", path.join(f.root, "nested"), "--", process.execPath, "--input-type=module", "-e", `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import {preparePrivateWriteDirectory} from ${JSON.stringify(module)};
    const settings=${JSON.stringify(f.settings)};
    fs.chmodSync(settings.isolation.privateWriteDir,0o700);
    settings.isolation.privateWriteMaxBytes=${limit};
    assert.throws(()=>preparePrivateWriteDirectory(settings),/nested mounts/);
  `], { encoding: "utf8", timeout: 15000 });
  assert.equal(nested.status, 0, nested.stderr);
  // The outer temporary mount is now gone: revalidation must reject its ordinary backing directory.
  assert.throws(() => validatePrivateWriteDirectory({ ...f.settings,
    isolation: { ...f.settings.isolation, privateWriteMaxBytes: limit } }), /not mounted/);
});
