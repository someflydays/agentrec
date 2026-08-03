import type { TokenUsage } from "./types.js";

/**
 * USD per million tokens. Cache reads bill at 0.1x the input rate; cache
 * writes at 1.25x (5-minute TTL) and 2x (1-hour TTL).
 *
 * Snapshot of Anthropic list pricing, August 2026. Costs are estimates for
 * orientation, not billing records — unknown models yield null rather than a
 * guess.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
}

function tier(inputPerMTok: number, outputPerMTok: number): ModelPricing {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: inputPerMTok * 0.1,
    cacheWrite5mPerMTok: inputPerMTok * 1.25,
    cacheWrite1hPerMTok: inputPerMTok * 2,
  };
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-fable-5": tier(10, 50),
  "claude-mythos-5": tier(10, 50),
  "claude-opus-5": tier(5, 25),
  "claude-opus-4-8": tier(5, 25),
  "claude-opus-4-7": tier(5, 25),
  "claude-opus-4-6": tier(5, 25),
  "claude-opus-4-5": tier(5, 25),
  "claude-opus-4-1": tier(15, 75),
  "claude-sonnet-5": tier(3, 15),
  "claude-sonnet-4-6": tier(3, 15),
  "claude-sonnet-4-5": tier(3, 15),
  "claude-haiku-4-5": tier(1, 5),
};

/**
 * Match a model id as it appears in transcripts: exact, date-suffixed
 * ("claude-haiku-4-5-20251001"), or provider-prefixed ("anthropic.claude-opus-5").
 */
export function lookupPricing(model: string): ModelPricing | null {
  const normalized = model.startsWith("anthropic.") ? model.slice("anthropic.".length) : model;
  const exact = MODEL_PRICING[normalized];
  if (exact) return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (normalized.startsWith(`${key}-`) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? (MODEL_PRICING[bestKey] ?? null) : null;
}

export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const pricing = lookupPricing(model);
  if (!pricing) return null;
  const total =
    usage.inputTokens * pricing.inputPerMTok +
    usage.outputTokens * pricing.outputPerMTok +
    usage.cacheReadInputTokens * pricing.cacheReadPerMTok +
    usage.cacheCreation5mInputTokens * pricing.cacheWrite5mPerMTok +
    usage.cacheCreation1hInputTokens * pricing.cacheWrite1hPerMTok;
  return total / 1_000_000;
}
