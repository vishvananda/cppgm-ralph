(function installRalphModelPricing(root) {
  // Anthropic-hosted model ids whose provider-reported cost we trust. Anything
  // else reaching Claude Code (an OpenRouter slug, a stealth model) is priced
  // from Claude's generic fallback card and cannot be relied on.
  const ANTHROPIC_MODEL_PATTERN = /^(claude-|anthropic[/-])/i;
  const rates = Object.freeze({
    // Standard short-context API-equivalent estimate (USD per 1M tokens).
    // https://developers.openai.com/api/docs/pricing (2026-09-07)
    "gpt-6-astra": Object.freeze({ input: 10.00, cachedInput: 1.00, output: 50.00 }),
    "gpt-5.6-sol": Object.freeze({ input: 5.00, cachedInput: 0.50, output: 30.00 }),
    "gpt-5.6-terra": Object.freeze({ input: 2.00, cachedInput: 0.25, output: 12.00 }),
    "gpt-5.6-luna": Object.freeze({ input: 0.20, cachedInput: 0.02, output: 1.20 }),
    "gpt-5.5": Object.freeze({ input: 5.00, cachedInput: 0.50, output: 30.00 }),
    // OpenRouter listed prices for DeepSeek Flash models (USD per 1M tokens,
    // checked 2026-09-23). Routed provider prices can vary.
    // https://openrouter.ai/~deepseek/deepseek-flash-latest
    "~deepseek/deepseek-flash-latest": Object.freeze({ input: 0.10, cachedInput: 0.01, output: 0.50 }),
    // The `~latest` alias resolves to a concrete version at request time. Claude
    // records that resolved id in its transcripts, so it needs the same rates or
    // recovered subagent usage would have no card to price against.
    "deepseek/deepseek-v4.1-flash": Object.freeze({ input: 0.10, cachedInput: 0.01, output: 0.50 }),
    // https://openrouter.ai/deepseek/deepseek-v4-flash
    "deepseek/deepseek-v4-flash": Object.freeze({ input: 0.04, cachedInput: 0.014, output: 0.50 }),
    "gpt-5.4-mini": Object.freeze({ input: 0.75, cachedInput: 0.075, output: 4.50 }),
    "gpt-5.4": Object.freeze({ input: 2.50, cachedInput: 0.25, output: 15.00 }),
    "claude-fable-5-1": Object.freeze({ input: 10.00, cachedInput: 0.25, output: 50.00 }),
    "claude-fable-5": Object.freeze({ input: 10.00, cachedInput: 1.00, output: 50.00 }),
    "claude-opus-5": Object.freeze({ input: 5.00, cachedInput: 0.50, output: 25.00 }),
    "claude-opus-4-8": Object.freeze({ input: 5.00, cachedInput: 0.50, output: 25.00 }),
    "claude-haiku-4-5": Object.freeze({ input: 1.00, cachedInput: 0.10, output: 5.00 }),
  });

  function normalizeUsageFields(usage) {
    if (!usage || typeof usage !== "object") return null;
    const input = Number(usage.input_tokens ?? usage.promptTokenCount ?? 0) || 0;
    const cached = Number(usage.cached_input_tokens ?? usage.cachedContentTokenCount ?? 0) || 0;
    const output = Number(
      usage.output_tokens ??
      ((usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)),
    ) || 0;
    const reasoning = Number(
      usage.reasoning_output_tokens ??
      usage.thinking_output_tokens ??
      usage.thoughtsTokenCount ??
      0,
    ) || 0;
    const total = Number(usage.total_tokens ?? usage.totalTokenCount ?? input + output) || 0;
    const costUsd = Number(usage.cost_usd ?? usage.total_cost_usd) || 0;
    return {
      input_tokens: Math.max(0, input),
      cached_input_tokens: Math.max(0, cached),
      output_tokens: Math.max(0, output),
      reasoning_output_tokens: Math.max(0, reasoning),
      total_tokens: Math.max(0, total),
      cost_usd: Math.max(0, costUsd),
    };
  }

  function hasUsage(usage) {
    return Boolean(
      usage &&
      (usage.input_tokens ||
        usage.cached_input_tokens ||
        usage.output_tokens ||
        usage.reasoning_output_tokens ||
        usage.total_tokens),
    );
  }

  function addUsageFields(left, right) {
    const a = normalizeUsageFields(left) ?? normalizeUsageFields({});
    const b = normalizeUsageFields(right) ?? normalizeUsageFields({});
    return {
      input_tokens: a.input_tokens + b.input_tokens,
      cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
      output_tokens: a.output_tokens + b.output_tokens,
      reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
      total_tokens: a.total_tokens + b.total_tokens,
      cost_usd: a.cost_usd + b.cost_usd,
    };
  }

  function normalizeModelUsage(entries) {
    const byModel = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const model = String(entry?.model ?? "").trim();
      const usage = normalizeUsageFields(entry);
      if (!model || !hasUsage(usage)) continue;
      byModel.set(model, addUsageFields(byModel.get(model), usage));
    }
    return [...byModel.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([model, usage]) => ({ model, ...usage }));
  }

  function normalizeUsage(usage) {
    const normalized = normalizeUsageFields(usage);
    if (!normalized) return null;
    const modelUsage = normalizeModelUsage(usage.model_usage);
    return modelUsage.length ? { ...normalized, model_usage: modelUsage } : normalized;
  }

  // Claude Code reports total_cost_usd from its own rate card. That is
  // authoritative for Anthropic-hosted models, but third-party models routed
  // through Claude Code (an OpenRouter slug, for example) are priced from a
  // generic fallback rate card and can be wrong by more than an order of
  // magnitude. Trust provider accounting only for Anthropic models; price
  // everything else from our own rate card.
  function isAnthropicModel(model) {
    return ANTHROPIC_MODEL_PATTERN.test(String(model ?? "").trim());
  }

  function providerCost(usage, model) {
    const normalized = normalizeUsageFields(usage);
    if (!normalized || !(normalized.cost_usd > 0)) return null;
    const name = String(model ?? "").trim();
    // An unknown model id is not evidence of a third-party route, so keep the
    // provider figure rather than silently dropping it.
    if (!name) return normalized.cost_usd;
    return isAnthropicModel(name) ? normalized.cost_usd : null;
  }

  function estimateCost(usage, model) {
    const normalized = normalizeUsageFields(usage);
    if (!normalized) return null;
    const trusted = providerCost(normalized, model);
    if (trusted != null) return trusted;
    const rate = model ? rates[model] : null;
    // Without a rate card the provider number is the only signal available, so
    // keep it as a last resort rather than reporting no cost at all.
    if (!rate) return normalized.cost_usd > 0 ? normalized.cost_usd : null;
    const cached = Math.min(normalized.cached_input_tokens, normalized.input_tokens);
    return (
      (normalized.input_tokens - cached) * rate.input +
      cached * rate.cachedInput +
      normalized.output_tokens * rate.output
    ) / 1_000_000;
  }

  function attributeUsage(usage, model) {
    const normalized = normalizeUsageFields(usage);
    if (!normalized || !model) return normalizeUsage(usage);
    const costUsd = estimateCost(normalized, model);
    const component = {
      model,
      ...normalized,
      cost_usd: Number.isFinite(costUsd) ? costUsd : normalized.cost_usd,
    };
    return {
      ...normalized,
      cost_usd: component.cost_usd,
      model_usage: [component],
    };
  }

  function addUsage(left, right) {
    const merged = addUsageFields(left, right);
    const modelUsage = normalizeModelUsage([
      ...(normalizeUsage(left)?.model_usage ?? []),
      ...(normalizeUsage(right)?.model_usage ?? []),
    ]);
    return modelUsage.length ? { ...merged, model_usage: modelUsage } : merged;
  }

  function costBreakdown(usage, fallbackModel = null) {
    const normalized = normalizeUsage(usage);
    if (!normalized) return [];
    if (normalized.model_usage?.length) {
      return normalized.model_usage.map((entry) => ({
        ...entry,
        cost_usd: estimateCost(entry, entry.model),
      }));
    }
    if (!fallbackModel || !hasUsage(normalized)) return [];
    return [{
      model: fallbackModel,
      ...normalized,
      cost_usd: estimateCost(normalized, fallbackModel),
    }];
  }

  root.RALPH_MODEL_PRICE_RATES = rates;
  root.RALPH_MODEL_PRICING = Object.freeze({
    addUsage,
    isAnthropicModel,
    providerCost,
    attributeUsage,
    costBreakdown,
    estimateCost,
    normalizeUsage,
  });
})(globalThis);
