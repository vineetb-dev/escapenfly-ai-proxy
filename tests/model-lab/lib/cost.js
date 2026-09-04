// Pricing as of 2026-08-13 (today). Sonnet 5 intro pricing applies through
// 2026-08-31 — revisit this table after that date. $/MTok.
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-5':           { input: 2.00, output: 10.00 }, // intro, through 2026-08-31
  'claude-opus-5':             { input: 5.00, output: 25.00 },
  'claude-fable-5':            { input: 10.00, output: 50.00 }
};

/**
 * @param {string} modelId
 * @param {object} usage - the Anthropic API response's usage block:
 *        { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 * @returns {{ usdCost: number, breakdown: object } | null}
 */
function estimateCost(modelId, usage) {
  const rate = PRICING[modelId];
  if (!rate || !usage) return null;
  const inputTok = usage.input_tokens || 0;
  const outputTok = usage.output_tokens || 0;
  const cacheWriteTok = usage.cache_creation_input_tokens || 0;
  const cacheReadTok = usage.cache_read_input_tokens || 0;

  const inputCost = (inputTok / 1_000_000) * rate.input;
  const outputCost = (outputTok / 1_000_000) * rate.output;
  const cacheWriteCost = (cacheWriteTok / 1_000_000) * rate.input * 1.25; // 5m TTL write premium
  const cacheReadCost = (cacheReadTok / 1_000_000) * rate.input * 0.1;

  const usdCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;
  return {
    usdCost,
    breakdown: { inputTok, outputTok, cacheWriteTok, cacheReadTok, inputCost, outputCost, cacheWriteCost, cacheReadCost }
  };
}

module.exports = { PRICING, estimateCost };
