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

export async function* streamWithReconnect(agent, prompt, {
  maxRetries = 2,
  onRetry = () => {},
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let nextPrompt = prompt;
  for (let retry = 0; ; retry += 1) {
    try {
      yield* agent.stream(nextPrompt);
      return;
    } catch (error) {
      if (retry >= maxRetries || !isTransientStreamError(error)) throw error;
      onRetry({ retry: retry + 1, maxRetries, error: describeStreamError(error) });
      await pause(Math.min(1000 * 2 ** retry, 5000));
      // The same Agent keeps its completed tool calls and session history.
      // A fresh prompt starts only the model response lost with the stream.
      nextPrompt = "The model stream disconnected during this Ralph turn. " +
        "Continue the assigned work from the current repository and conversation state. " +
        "Do not repeat completed tool actions unless validation requires it.";
    }
  }
}
