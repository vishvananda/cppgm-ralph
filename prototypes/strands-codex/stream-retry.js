const NETWORK_CODES = new Set([
  "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED",
]);

function errorChain(error) {
  const chain = [];
  for (let current = error; current && chain.length < 4; current = current.cause) {
    chain.push(current);
  }
  return chain;
}

export function describeStreamError(error) {
  return errorChain(error).map((part) => {
    const name = part?.name ?? "Error";
    const message = part?.message ?? String(part);
    return `${name}${part?.code ? ` [${part.code}]` : ""}: ${message}`;
  }).join("; caused by ");
}

export function isTransientStreamError(error) {
  return errorChain(error).some((part) =>
    NETWORK_CODES.has(part?.code) ||
    /^terminated$/i.test(part?.message ?? "") ||
    (part?.name === "TypeError" && /^fetch failed$/i.test(part?.message ?? "")));
}

function isMaxTokensError(error) {
  return errorChain(error).some((part) => part?.name === "MaxTokensError");
}

export async function* streamWithReconnect(agent, prompt, {
  maxRetries = 2,
  maxTokenRetries = 1,
  onRetry = () => {},
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let nextPrompt = prompt;
  let networkRetries = 0;
  let tokenRetries = 0;
  while (true) {
    try {
      yield* agent.stream(nextPrompt);
      return;
    } catch (error) {
      if (isMaxTokensError(error) && tokenRetries < maxTokenRetries) {
        tokenRetries += 1;
        onRetry({ reason: "max_tokens", retry: tokenRetries, maxRetries: maxTokenRetries,
          error: describeStreamError(error) });
        // The SDK discards the incomplete response. Start a new invocation in
        // the same session so context management can compress before retrying.
        nextPrompt = "The last model response reached its output-token limit before it finished. " +
          "Continue the assigned work from the current repository and conversation state. " +
          "Keep the next response brief and work in small tool steps. " +
          "Do not repeat completed tool actions unless validation requires it.";
        continue;
      }
      if (!isTransientStreamError(error) || networkRetries >= maxRetries) throw error;
      networkRetries += 1;
      onRetry({ reason: "network", retry: networkRetries, maxRetries,
        error: describeStreamError(error) });
      await pause(Math.min(1000 * 2 ** (networkRetries - 1), 5000));
      // The same Agent keeps its completed tool calls and session history.
      // A fresh prompt starts only the model response lost with the stream.
      nextPrompt = "The model stream disconnected during this Ralph turn. " +
        "Continue the assigned work from the current repository and conversation state. " +
        "Do not repeat completed tool actions unless validation requires it.";
    }
  }
}
