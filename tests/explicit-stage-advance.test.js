import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const explicit of [true, false]) {
  test(explicit
    ? "a literal PA34 primary advances through PA35 and completes the final audit"
    : "an unscoped literal primary remains a single-command run", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-explicit-stage-"));
    t.after(() => fs.rm(root, { recursive:true, force:true }));
    const workdir = path.join(root, "work");
    for (const stage of ["pa34", "pa35"]) {
      await fs.mkdir(path.join(workdir, stage), { recursive:true });
      await fs.writeFile(path.join(workdir, stage, "README.md"), `${stage}\n`);
    }
    const git = args => execFileSync("git", args, { cwd:workdir, stdio:"pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);
    const remote = path.join(root, "remote.git");
    execFileSync("git", ["init", "--bare", "-q", remote]);
    git(["remote", "add", "origin", remote]);
    git(["push", "-qu", "origin", "HEAD"]);
    const trace = path.join(root, "checks.jsonl");
    const check = path.join(root, "check.mjs");
    await fs.writeFile(check, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv[2])+'\\n');
console.log('check passed');\n`);
    const configPath = path.join(root, "ralph.config.json");
    const stateBaseDir = path.join(root, "state");
    await fs.writeFile(configPath, JSON.stringify({
      name:"literal-stage", provider:"strands", model:"fake-model", reasoningEffort:"high",
      workdir, useExistingWorkdir:true, stateBaseDir, initialStage:"pa34",
      extraStages:["pa34", "pa35"], resourceLimits:false, sessionIsolation:false,
      loopGoalsEnabled:false, maxTurns:1,
      checks: Object.fromEntries(["pa34", "pa35"].map(stage => [stage, {
        command:`${process.execPath} ${check} ${stage}`, kind:"generic", primary:true,
        required:true, onlyStages:[stage], ...(explicit ? {targetStage:stage} : {}),
      }])),
      phases:[{name:"implement",checks:["pa34","pa35"]},
        {name:"audit",checks:["pa34","pa35"]}],
    }));
    const run = () => spawnSync(process.execPath, [path.join(repo, "ralph.js")], {
      cwd:repo, encoding:"utf8", timeout:20_000,
      env:{...process.env, RALPH_CONFIG:configPath, RALPH_RESOURCE_LIMITS:"0"},
    });
    const result = run();
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    const stages = (await fs.readFile(trace,"utf8")).trim().split("\n").map(JSON.parse);
    const visited = stages.filter((stage,index) => stage !== stages[index-1]);
    assert.deepEqual(visited, explicit ? ["pa34","pa35"] : ["pa34"],output);
    if (explicit) assert.match(output,/Advancing to pa35/);
    assert.match(output,/All required checks passed for final phase audit/);
    const state = JSON.parse(await fs.readFile(path.join(stateBaseDir,"literal-stage-fake-model-high","state.json"),"utf8"));
    assert.equal(state.activeStage,null);
    assert.equal(state.activePhase,null);
    assert.equal(state.lastTestStatus.targetStage,explicit ? "pa35" : null);
  });
}
