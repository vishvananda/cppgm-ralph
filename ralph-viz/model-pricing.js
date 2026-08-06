(function installRalphModelPricing(root) {
  root.RALPH_MODEL_PRICE_RATES = Object.freeze({
    "gpt-5.6-sol": Object.freeze({ input: 5.00, cachedInput: 0.50, output: 30.00 }),
    "gpt-5.6-terra": Object.freeze({ input: 2.00, cachedInput: 0.25, output: 12.00 }),
    "gpt-5.6-luna": Object.freeze({ input: 0.20, cachedInput: 0.02, output: 1.20 }),
    "gpt-5.5": Object.freeze({ input: 5.00, cachedInput: 0.50, output: 30.00 }),
    "gpt-5.4-mini": Object.freeze({ input: 0.75, cachedInput: 0.075, output: 4.50 }),
    "gpt-5.4": Object.freeze({ input: 2.50, cachedInput: 0.25, output: 15.00 }),
    "claude-fable-5": Object.freeze({ input: 10.00, cachedInput: 1.00, output: 50.00 }),
    "claude-opus-5": Object.freeze({ input: 5.00, cachedInput: 0.50, output: 25.00 }),
    "claude-opus-4-8": Object.freeze({ input: 5.00, cachedInput: 0.50, output: 25.00 }),
    "claude-haiku-4-5": Object.freeze({ input: 1.00, cachedInput: 0.10, output: 5.00 }),
  });
})(globalThis);
