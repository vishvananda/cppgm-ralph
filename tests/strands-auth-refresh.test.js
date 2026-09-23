import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexSubscriptionModel } from "../prototypes/strands-codex/codex-model.js";

test("a 401 asks Codex to refresh the login and retries with the new token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ralph-strands-auth-"));
  const authFile = path.join(dir, "auth.json");
  const cli = path.join(dir, "codex-refresh");
  const auth = (token) => ({ auth_mode: "chatgpt", tokens: {
    access_token: token, account_id: "account",
  } });
  await writeFile(authFile, JSON.stringify(auth("old")));
  await writeFile(cli, `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.readFileSync(0, "utf8");\nfs.writeFileSync(process.env.OPENAI_CODEX_AUTH_FILE, ${JSON.stringify(JSON.stringify(auth("new")))});\n`);
  await chmod(cli, 0o755);
  const originalFetch = globalThis.fetch;
  const originalAuthFile = process.env.OPENAI_CODEX_AUTH_FILE;
  const seen = [];
  process.env.OPENAI_CODEX_AUTH_FILE = authFile;
  globalThis.fetch = async (_url, init) => {
    seen.push(new Headers(init.headers).get("Authorization"));
    if (seen.length === 1) return new Response("", { status: 401 });
    const events = [
      { type: "response.created", response: { id: "response_1" } },
      { type: "response.output_text.delta", delta: "OK" },
      { type: "response.completed", response: { id: "response_1", output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const model = createCodexSubscriptionModel({ model: "gpt-6-luna", codexPath: cli });
    for await (const _event of model.stream([{ role: "user", content: [{ type: "textBlock", text: "Hi" }] }])) {}
    assert.deepEqual(seen, ["Bearer old", "Bearer new"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAuthFile == null) delete process.env.OPENAI_CODEX_AUTH_FILE;
    else process.env.OPENAI_CODEX_AUTH_FILE = originalAuthFile;
    await rm(dir, { recursive: true, force: true });
  }
});
