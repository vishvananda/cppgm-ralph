import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archivedRepositoryUrl, githubRepositoryUrl, resolveRunRepositoryUrl } from "../run-repository-url.js";

test("repository links accept GitHub SSH and HTTPS remotes without credentials", () => {
  for (const remote of ["git@github.com:owner/run.git", "ssh://git@github.com/owner/run.git",
    "https://github.com/owner/run.git", "https://github.com/owner/run/"]) {
    assert.equal(githubRepositoryUrl(remote), "https://github.com/owner/run");
  }
  assert.equal(githubRepositoryUrl("https://secret@github.com/owner/run.git"), null);
  assert.equal(githubRepositoryUrl("https://github.com.evil/owner/run"), null);
});

test("all archived generations and fork names retain verified repository links", () => {
  for (const shape of ["v3relay-claude-fable-5-xhigh", "v4codex-gpt-6-astra-xhigh",
    "v4deep-deepseek-deepseek-flash-latest-high", "v4luna-gpt-6-luna-max",
    "v4strands-gpt-6-luna-max", "v4unreal-gpt-6-luna-max",
    "v5sol-batched-gpt-6.1-sol-high", "v5scratch-gpt-6.1-sol-high",
    "v6sol-gpt-6.1-sol-high", "v6opus-opus-high"]) {
    assert.match(archivedRepositoryUrl(shape), /^https:\/\/github.com\/vishvananda\/cppgm-run-/);
  }
  assert.equal(archivedRepositoryUrl("15-v5sol-batched-gpt-6.1-sol-high/run"),
    "https://github.com/vishvananda/cppgm-run-v5sol-batched");
  assert.equal(archivedRepositoryUrl("unknown-gpt-6-high"), null);
});

test("new runs discover their actual origin and missing archived checkouts use the catalog", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-repository-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync("git", ["-C", directory, "remote", "add", "origin", "git@github.com:another-owner/new-run.git"]);
  assert.equal(await resolveRunRepositoryUrl("new-gpt-6-high", directory), "https://github.com/another-owner/new-run");
  assert.equal(await resolveRunRepositoryUrl("v4deep-deepseek-latest-high", path.join(directory, "absent")),
    "https://github.com/vishvananda/cppgm-run-v4deep");
});
