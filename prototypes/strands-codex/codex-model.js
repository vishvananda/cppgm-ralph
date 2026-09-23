import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";

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

export function createCodexSubscriptionModel({ model = "gpt-6-luna", effort = "max" } = {}) {
  return new OpenAIModel({
    api: "responses",
    modelId: model,
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
        return fetch(url, {
          ...init,
          headers,
          body: JSON.stringify(body),
          redirect: "manual",
        });
      },
    },
    params: { reasoning: { effort, summary: "auto" } },
  });
}
