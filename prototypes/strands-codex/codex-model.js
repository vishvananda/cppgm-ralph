import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { ReasoningReplay } from "./reasoning-replay.js";

const CODEX_URL = "https://chatgpt.com/backend-api/codex";

function authPath() {
  return process.env.OPENAI_CODEX_AUTH_FILE ?? path.join(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "auth.json",
  );
}

async function subscriptionCredentials() {
  const auth = JSON.parse(await readFile(authPath(), "utf8"));
  if (auth.auth_mode !== "chatgpt") {
    throw new Error("Codex must be signed in with ChatGPT; run `codex login`.");
  }
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!accessToken || !accountId) {
    throw new Error("Codex ChatGPT credentials are incomplete; run `codex login`.");
  }
  return { accessToken, accountId };
}

async function refreshSubscriptionWithCodex(codexPath, model) {
  const file = authPath();
  if (path.basename(file) !== "auth.json") {
    throw new Error("Codex CLI can refresh only an auth.json login; refresh the configured auth file externally.");
  }
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(codexPath, [
        "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
        "--sandbox", "read-only", "--model", model,
        "-c", "model_reasoning_effort=low", "Reply OK.",
      ], { cwd: os.tmpdir(), env: { ...process.env, CODEX_HOME: path.dirname(file) },
        timeout: 120_000, maxBuffer: 128_000 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
      child.stdin?.end();
    });
  } catch {
    throw new Error("Codex login could not be refreshed; run `codex login` and retry.");
  }
}

function tapResponsesEvents(response, { onUsage, reasoningReplay }) {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  let buffered = "";
  const inspect = (frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if ((event.type === "response.completed" || event.type === "response.incomplete") &&
        event.response?.usage) {
      onUsage?.(event.response.usage);
    }
    if (event.type === "response.completed") reasoningReplay.remember(event.response?.output);
  };
  const scan = (text) => {
    buffered += text;
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffered))) {
      inspect(buffered.slice(0, match.index));
      buffered = buffered.slice(match.index + match[0].length);
    }
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      scan(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      scan(decoder.decode());
      if (buffered) inspect(buffered);
    },
  }));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createCodexSubscriptionModel({ model = "gpt-6-luna", effort = "max", webSearch = false, onUsage, codexPath = "codex" } = {}) {
  const reasoningReplay = new ReasoningReplay();
  return new OpenAIModel({
    api: "responses",
    modelId: model,
    contextWindowLimit: 200_000,
    // OpenAI's client requires an API key at construction. The custom fetch
    // replaces this placeholder with the current Codex subscription token.
    apiKey: "codex-subscription-placeholder",
    clientConfig: {
      baseURL: CODEX_URL,
      fetch: async (url, init) => {
        if (String(url) !== `${CODEX_URL}/responses`) {
          throw new Error("Unexpected Codex request destination");
        }
        const { accessToken, accountId } = await subscriptionCredentials();
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${accessToken}`);
        headers.set("ChatGPT-Account-ID", accountId);
        headers.set("originator", "ralph-strands-prototype");
        headers.set("Accept", "text/event-stream");

        const body = JSON.parse(String(init?.body));
        body.store = false;
        body.include = [...new Set([...(body.include ?? []), "reasoning.encrypted_content"])];
        body.input = reasoningReplay.apply(body.input);
        const options = {
          ...init,
          headers,
          body: JSON.stringify(body),
          redirect: "manual",
        };
        let response = await fetch(url, options);
        if (response.status === 401) {
          let refreshed = await subscriptionCredentials();
          if (refreshed.accessToken === accessToken) {
            await refreshSubscriptionWithCodex(codexPath, model);
            refreshed = await subscriptionCredentials();
          }
          if (refreshed.accessToken === accessToken) {
            throw new Error("Codex login is expired; run `codex login` and retry.");
          }
          headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
          headers.set("ChatGPT-Account-ID", refreshed.accountId);
          response = await fetch(url, options);
        }
        return tapResponsesEvents(response, { onUsage, reasoningReplay });
      },
    },
    params: {
      reasoning: { effort, summary: "auto" },
      ...(webSearch ? { tools: [{ type: "web_search" }] } : {}),
    },
  });
}
