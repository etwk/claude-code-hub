import { describe, expect, test } from "vitest";
import {
  formatCacheCostRatio,
  resolveCacheCostRatios,
  resolveInputTokenUnitPrice,
} from "@/lib/utils/cache-cost-ratio";
import type { StoredCostBreakdown } from "@/types/cost-breakdown";

function breakdown(overrides: Partial<StoredCostBreakdown>): StoredCostBreakdown {
  return {
    input: "0",
    input_token_cost: "0",
    output: "0",
    cache_creation: "0",
    cache_read: "0",
    base_total: "0",
    provider_multiplier: 1,
    group_multiplier: 1,
    total: "0",
    ...overrides,
  };
}

describe("resolveInputTokenUnitPrice", () => {
  test.each(["0.013", "0.023"])(
    "excludes request fees and image charges in the input bucket (%s)",
    (input) => {
      expect(
        resolveInputTokenUnitPrice(breakdown({ input, input_token_cost: "0.003" }), 1000)
      ).toBeCloseTo(0.000003);
    }
  );

  test.each([undefined, null, "", " ", "NaN", "Infinity", "-1", false, 0])(
    "does not infer a unit price without a valid token subtotal (%s)",
    (cost) => {
      expect(
        resolveInputTokenUnitPrice(
          breakdown({ input: "0.013", input_token_cost: cost as string }),
          1000
        )
      ).toBeNull();
    }
  );

  test("preserves an explicitly free input token price despite other input charges", () => {
    expect(
      resolveInputTokenUnitPrice(breakdown({ input: "0.01", input_token_cost: "0" }), 1000)
    ).toBe(0);
  });

  test.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns unknown for invalid input token counts (%s)",
    (tokens) => {
      expect(
        resolveInputTokenUnitPrice(breakdown({ input_token_cost: "0.003" }), tokens)
      ).toBeNull();
    }
  );

  test("returns unknown without a breakdown or for non-finite or underflowed unit prices", () => {
    expect(resolveInputTokenUnitPrice(null, 1000)).toBeNull();
    expect(resolveInputTokenUnitPrice(breakdown({ input_token_cost: "1e308" }), 1e-308)).toBeNull();
    expect(resolveInputTokenUnitPrice(breakdown({ input_token_cost: "5e-324" }), 1000)).toBeNull();
  });
});

describe("resolveCacheCostRatios", () => {
  test.each(["0.013", "0.023"])(
    "uses the token-only input subtotal rather than the combined input bucket (%s)",
    (input) => {
      const ratios = resolveCacheCostRatios({
        costBreakdown: breakdown({
          input,
          input_token_cost: "0.003",
          cache_creation: "0.00975",
          cache_creation_5m: "0.00375",
          cache_creation_1h: "0.006",
          cache_read: "0.0003",
        }),
        inputTokens: 1000,
        cacheWrite5mTokens: 1000,
        cacheWrite1hTokens: 1000,
        cacheReadTokens: 1000,
      });
      expect(formatCacheCostRatio(ratios.cacheWrite5m)).toBe("1.25x");
      expect(formatCacheCostRatio(ratios.cacheWrite1h)).toBe("2x");
      expect(formatCacheCostRatio(ratios.cacheRead)).toBe("0.1x");
    }
  );

  test.each([undefined, "0"])(
    "leaves ratios unknown when the input subtotal is absent or free (%s)",
    (inputTokenCost) => {
      expect(
        resolveCacheCostRatios({
          costBreakdown: breakdown({
            input: "0.013",
            input_token_cost: inputTokenCost,
            cache_creation_5m: "0.00375",
            cache_creation_1h: "0.006",
            cache_read: "0.0003",
          }),
          inputTokens: 1000,
          cacheWrite5mTokens: 1000,
          cacheWrite1hTokens: 1000,
          cacheReadTokens: 1000,
        })
      ).toEqual({ cacheWrite5m: null, cacheWrite1h: null, cacheRead: null });
    }
  );

  test("derives xAI cache read ratio (0.25x) from stored costs", () => {
    // Real grok-4.7 row: $2/M input, $0.5/M cache read
    const ratios = resolveCacheCostRatios({
      costBreakdown: breakdown({
        input: "0.002488",
        input_token_cost: "0.002488",
        cache_read: "0.04128",
      }),
      inputTokens: 1244,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 82560,
    });
    expect(formatCacheCostRatio(ratios.cacheRead)).toBe("0.25x");
    expect(ratios.cacheWrite5m).toBeNull();
    expect(ratios.cacheWrite1h).toBeNull();
  });

  test("derives Anthropic ratios from per-TTL cache creation costs", () => {
    const ratios = resolveCacheCostRatios({
      costBreakdown: breakdown({
        input: "0.003",
        input_token_cost: "0.003",
        cache_creation: "0.01125",
        cache_creation_5m: "0.00375",
        cache_creation_1h: "0.0075",
        cache_read: "0.0003",
      }),
      inputTokens: 1000,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 1250,
      cacheReadTokens: 1000,
    });
    expect(formatCacheCostRatio(ratios.cacheWrite5m)).toBe("1.25x");
    expect(formatCacheCostRatio(ratios.cacheWrite1h)).toBe("2x");
    expect(formatCacheCostRatio(ratios.cacheRead)).toBe("0.1x");
  });

  test("does not invent a zero rate for a missing per-TTL field", () => {
    const ratios = resolveCacheCostRatios({
      costBreakdown: breakdown({
        input: "0.001",
        input_token_cost: "0.001",
        cache_creation_5m: "0.00125",
      }),
      inputTokens: 1000,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 500,
      cacheReadTokens: 0,
    });
    expect(formatCacheCostRatio(ratios.cacheWrite5m)).toBe("1.25x");
    expect(ratios.cacheWrite1h).toBeNull();
  });

  test("uses aggregate cache_creation for legacy rows with a single TTL", () => {
    const ratios = resolveCacheCostRatios({
      costBreakdown: breakdown({
        input: "0.001",
        input_token_cost: "0.001",
        cache_creation: "0.002",
      }),
      inputTokens: 1000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 1000,
      cacheReadTokens: 0,
    });
    expect(ratios.cacheWrite5m).toBeNull();
    expect(formatCacheCostRatio(ratios.cacheWrite1h)).toBe("2x");
  });

  test("returns null cache write ratios for legacy rows with mixed TTLs", () => {
    const ratios = resolveCacheCostRatios({
      costBreakdown: breakdown({
        input: "0.001",
        input_token_cost: "0.001",
        cache_creation: "0.004",
      }),
      inputTokens: 1000,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 1000,
      cacheReadTokens: 0,
    });
    expect(ratios.cacheWrite5m).toBeNull();
    expect(ratios.cacheWrite1h).toBeNull();
  });

  test("returns all nulls without a breakdown", () => {
    expect(
      resolveCacheCostRatios({
        costBreakdown: null,
        inputTokens: 1000,
        cacheWrite5mTokens: 100,
        cacheWrite1hTokens: 100,
        cacheReadTokens: 100,
      })
    ).toEqual({ cacheWrite5m: null, cacheWrite1h: null, cacheRead: null });
  });

  test("returns all nulls when the input rate cannot be derived", () => {
    const empty = { cacheWrite5m: null, cacheWrite1h: null, cacheRead: null };
    const base = {
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 100,
    };
    expect(
      resolveCacheCostRatios({
        ...base,
        costBreakdown: breakdown({
          input: "0.001",
          input_token_cost: "0.001",
          cache_read: "0.0001",
        }),
        inputTokens: 0,
      })
    ).toEqual(empty);
    expect(
      resolveCacheCostRatios({
        ...base,
        costBreakdown: breakdown({ input: "0", cache_read: "0.0001" }),
        inputTokens: 1000,
      })
    ).toEqual(empty);
    expect(
      resolveCacheCostRatios({
        ...base,
        costBreakdown: breakdown({
          input: "0.001",
          input_token_cost: "not-a-number",
          cache_read: "0.0001",
        }),
        inputTokens: 1000,
      })
    ).toEqual(empty);
  });

  test("returns null for an unparseable cache read cost", () => {
    const ratios = resolveCacheCostRatios({
      costBreakdown: breakdown({
        input: "0.001",
        input_token_cost: "0.001",
        cache_read: "-1",
      }),
      inputTokens: 1000,
      cacheWrite5mTokens: undefined,
      cacheWrite1hTokens: undefined,
      cacheReadTokens: 1000,
    });
    expect(ratios.cacheRead).toBeNull();
  });

  test.each([undefined, null, "", " ", "NaN", "Infinity", "-1", false, 0])(
    "returns unknown ratios for an invalid stored cache cost (%s)",
    (cost) => {
      const ratios = resolveCacheCostRatios({
        costBreakdown: breakdown({
          input: "0.001",
          input_token_cost: "0.001",
          cache_creation_5m: cost as string,
          cache_creation_1h: "0.002",
          cache_read: cost as string,
        }),
        inputTokens: 1000,
        cacheWrite5mTokens: 1000,
        cacheWrite1hTokens: 1000,
        cacheReadTokens: 1000,
      });
      expect(ratios.cacheWrite5m).toBeNull();
      expect(ratios.cacheRead).toBeNull();
      expect(ratios.cacheWrite1h).toBeCloseTo(2);
    }
  );

  test("preserves explicitly recorded free cache pricing", () => {
    const ratios = resolveCacheCostRatios({
      costBreakdown: breakdown({
        input: "0.001",
        input_token_cost: "0.001",
        cache_creation_5m: "0",
        cache_creation_1h: "0",
        cache_read: "0",
      }),
      inputTokens: 1000,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 1000,
      cacheReadTokens: 1000,
    });
    expect(ratios).toEqual({ cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
    expect(formatCacheCostRatio(ratios.cacheRead)).toBe("0x");
  });

  test.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not derive a rate from invalid token counts (%s)",
    (tokens) => {
      const ratios = resolveCacheCostRatios({
        costBreakdown: breakdown({
          input: "0.001",
          input_token_cost: "0.001",
          cache_creation_5m: "0.00125",
          cache_creation_1h: "0.002",
          cache_read: "0.00025",
        }),
        inputTokens: 1000,
        cacheWrite5mTokens: tokens,
        cacheWrite1hTokens: tokens,
        cacheReadTokens: tokens,
      });
      expect(ratios).toEqual({ cacheWrite5m: null, cacheWrite1h: null, cacheRead: null });
    }
  );

  test("does not return non-finite ratios for extreme stored costs", () => {
    const input = {
      inputTokens: 1000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 1,
    };
    expect(
      resolveCacheCostRatios({
        ...input,
        costBreakdown: breakdown({
          input: "5e-324",
          input_token_cost: "5e-324",
          cache_read: "0.001",
        }),
      }).cacheRead
    ).toBeNull();
    expect(
      resolveCacheCostRatios({
        ...input,
        costBreakdown: breakdown({
          input: "0.001",
          input_token_cost: "0.001",
          cache_read: "1e308",
        }),
      }).cacheRead
    ).toBeNull();
  });
});

describe("formatCacheCostRatio", () => {
  test("formats with at most two decimals and trims trailing zeros", () => {
    expect(formatCacheCostRatio(0.25)).toBe("0.25x");
    expect(formatCacheCostRatio(2)).toBe("2x");
    expect(formatCacheCostRatio(0.1000001)).toBe("0.1x");
    expect(formatCacheCostRatio(1 / 3)).toBe("0.33x");
  });

  test("returns null for unknown ratios", () => {
    expect(formatCacheCostRatio(null)).toBeNull();
    expect(formatCacheCostRatio(Number.NaN)).toBeNull();
    expect(formatCacheCostRatio(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatCacheCostRatio(-1)).toBeNull();
  });
});
