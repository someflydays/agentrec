import { describe, expect, it } from "vitest";
import { estimateCostUsd, lookupPricing, MODEL_PRICING } from "../src/pricing.js";
import type { TokenUsage } from "../src/types.js";
import { zeroUsage } from "../src/types.js";

describe("lookupPricing", () => {
  it("matches an exact model id", () => {
    expect(lookupPricing("claude-fable-5")).toEqual({
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheReadPerMTok: 1,
      cacheWrite5mPerMTok: 12.5,
      cacheWrite1hPerMTok: 20,
    });
  });

  it("matches a date-suffixed model id", () => {
    expect(lookupPricing("claude-haiku-4-5-20251001")).toBe(MODEL_PRICING["claude-haiku-4-5"]);
    expect(lookupPricing("claude-sonnet-4-5-20250929")).toBe(MODEL_PRICING["claude-sonnet-4-5"]);
  });

  it("matches a bedrock-prefixed model id", () => {
    expect(lookupPricing("anthropic.claude-opus-5")).toBe(MODEL_PRICING["claude-opus-5"]);
  });

  it("matches a model id that is both provider-prefixed and date-suffixed", () => {
    expect(lookupPricing("anthropic.claude-haiku-4-5-20251001")).toBe(
      MODEL_PRICING["claude-haiku-4-5"],
    );
  });

  it("prefers the longest matching prefix", () => {
    expect(lookupPricing("claude-opus-4-5-20260210")).toBe(MODEL_PRICING["claude-opus-4-5"]);
    expect(lookupPricing("claude-opus-4-1-20250805")).toBe(MODEL_PRICING["claude-opus-4-1"]);
  });

  it("returns null for an unknown model", () => {
    expect(lookupPricing("claude-mystery-9")).toBeNull();
    expect(lookupPricing("gpt-4o")).toBeNull();
    expect(lookupPricing("")).toBeNull();
  });

  it("does not treat a bare version-family name as a match", () => {
    expect(lookupPricing("claude-opus")).toBeNull();
    expect(lookupPricing("claude-haiku-4-5x")).toBeNull();
  });

  it("derives cache rates from the input rate for every known model", () => {
    for (const pricing of Object.values(MODEL_PRICING)) {
      expect(pricing.cacheReadPerMTok).toBeCloseTo(pricing.inputPerMTok * 0.1, 10);
      expect(pricing.cacheWrite5mPerMTok).toBeCloseTo(pricing.inputPerMTok * 1.25, 10);
      expect(pricing.cacheWrite1hPerMTok).toBeCloseTo(pricing.inputPerMTok * 2, 10);
    }
  });
});

describe("estimateCostUsd", () => {
  it("bills all five usage components", () => {
    // claude-opus-5 rates per MTok: input 5, output 25, cache read 0.5,
    // 5m cache write 6.25, 1h cache write 10.
    //     1_000 * 5    =     5_000
    //     2_000 * 25   =    50_000
    //   100_000 * 0.5  =    50_000
    //    40_000 * 6.25 =   250_000
    //    10_000 * 10   =   100_000
    //                    -------- 455_000 / 1e6 = 0.455
    const usage: TokenUsage = {
      inputTokens: 1_000,
      outputTokens: 2_000,
      cacheReadInputTokens: 100_000,
      cacheCreation5mInputTokens: 40_000,
      cacheCreation1hInputTokens: 10_000,
    };

    expect(estimateCostUsd("claude-opus-5", usage)).toBeCloseTo(0.455, 10);
  });

  it("scales linearly with token counts", () => {
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
    };

    expect(estimateCostUsd("claude-sonnet-5", usage)).toBeCloseTo(3, 10);
  });

  it("costs nothing for a request that consumed nothing", () => {
    expect(estimateCostUsd("claude-fable-5", zeroUsage())).toBe(0);
  });

  it("resolves pricing through the same normalization as lookupPricing", () => {
    const usage: TokenUsage = { ...zeroUsage(), outputTokens: 1_000_000 };
    expect(estimateCostUsd("anthropic.claude-haiku-4-5-20251001", usage)).toBeCloseTo(5, 10);
  });

  it("returns null for an unknown model instead of guessing", () => {
    expect(estimateCostUsd("claude-mystery-9", zeroUsage())).toBeNull();
  });
});
