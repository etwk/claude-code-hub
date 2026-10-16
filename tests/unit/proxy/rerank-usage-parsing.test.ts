import { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseUsageFromResponseText,
  resolveBillableUsageMetricsForCost,
} from "@/app/v1/_lib/proxy/response-handler";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { calculateRequestCost } from "@/lib/utils/cost-calculation";
import type { ModelPriceData } from "@/types/model-price";

const RERANK_PATH = "/v1/rerank";

async function createPricingSession(priceData: ModelPriceData | null): Promise<ProxySession> {
  const request = new Request(`https://hub.example${RERANK_PATH}`, {
    body: JSON.stringify({
      model: "rerank-example",
      query: "Which document discusses astronomy?",
      documents: ["The moon orbits Earth.", "Bread is made from flour."],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const session = await ProxySession.fromContext(new Context(request));
  vi.spyOn(session, "getResolvedPricingByBillingSource").mockResolvedValue(
    priceData
      ? {
          priceData,
          resolvedModelName: "rerank-example",
          resolvedPricingProviderKey: "example",
          source: "official_fallback",
        }
      : null
  );
  return session;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rerank usage parsing", () => {
  it.each([
    { prompt_tokens: 23, completion_tokens: 2 },
    { input_tokens: 23, output_tokens: 2 },
    { input_tokens: 23, prompt_tokens: 91, output_tokens: 2, completion_tokens: 19 },
  ])("preserves standard directional usage precedence: %j", (usage) => {
    const result = parseUsageFromResponseText(
      JSON.stringify({
        usage,
        meta: {
          billed_units: { input_tokens: 80, output_tokens: 10 },
          tokens: { input_tokens: 90, output_tokens: 20 },
        },
      }),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ input_tokens: 23, output_tokens: 2 });
    expect(result.usageRecord).toEqual(usage);
  });

  it("uses explicit billed directions before a standard total-only report and raw token counts", () => {
    const billedUnits = { input_tokens: 17, output_tokens: 3, total_tokens: 100, search_units: 1 };
    const result = parseUsageFromResponseText(
      JSON.stringify({
        usage: { total_tokens: 90, completion_tokens: 0 },
        meta: { billed_units: billedUnits, tokens: { input_tokens: 70, output_tokens: 20 } },
      }),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ input_tokens: 17, output_tokens: 3 });
    expect(result.usageRecord).toEqual(billedUnits);
  });

  it("prefers a standard total-only report over billed and raw totals", () => {
    const result = parseUsageFromResponseText(
      JSON.stringify({
        usage: { total_tokens: 31 },
        meta: {
          billed_units: { total_tokens: 32 },
          tokens: { input_tokens: 33, output_tokens: 4 },
        },
      }),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ input_tokens: 31, output_tokens: 0 });
    expect(result.usageRecord).toEqual({ total_tokens: 31 });
    expect(result.usageRecord).not.toHaveProperty("input_tokens");
  });

  it("uses billed total-only tokens before raw meta.tokens without inventing output", () => {
    const result = parseUsageFromResponseText(
      JSON.stringify({
        meta: {
          billed_units: { total_tokens: 29, search_units: 1 },
          tokens: { input_tokens: 80, output_tokens: 5 },
        },
      }),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ input_tokens: 29, output_tokens: 0 });
    expect(result.usageRecord).toEqual({ total_tokens: 29, search_units: 1 });
  });

  it.each([
    { usage: { total_tokens: 41 } },
    { usage: { total_tokens: 41, completion_tokens: 0 } },
    { usage: { total_tokens: 41, output_tokens: 0 } },
    { meta: { billed_units: { total_tokens: 41 } } },
    { meta: { billed_units: { total_tokens: 41, output_tokens: 0 } } },
  ])("maps rerank total-only usage to consumed input tokens: %j", (response) => {
    const result = parseUsageFromResponseText(
      JSON.stringify(response),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ input_tokens: 41, output_tokens: 0 });
  });

  it.each([
    { usage: { output_tokens: 3, total_tokens: 41 } },
    { usage: { completion_tokens: 3, total_tokens: 41 } },
    { meta: { billed_units: { output_tokens: 3, total_tokens: 41 } } },
  ])("does not invent an input split from positive output and a total: %j", (response) => {
    const result = parseUsageFromResponseText(
      JSON.stringify(response),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ output_tokens: 3 });
  });

  it.each([
    { usage: { input_tokens: 0, prompt_tokens: 50, output_tokens: 0, total_tokens: 100 } },
    { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 100 } },
    { meta: { billed_units: { input_tokens: 0, output_tokens: 0, total_tokens: 100 } } },
  ])("preserves authoritative explicit zero instead of falling through: %j", (response) => {
    const meta = "meta" in response ? response.meta : {};
    const result = parseUsageFromResponseText(
      JSON.stringify({
        ...response,
        meta: { ...meta, tokens: { input_tokens: 200, output_tokens: 9 } },
      }),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it.each([null, [], 7, "invalid", {}, { input_tokens: -1, output_tokens: "2" }])(
    "does not let empty or invalid standard usage suppress billed tokens: %j",
    (usage) => {
      const result = parseUsageFromResponseText(
        JSON.stringify({ usage, meta: { billed_units: { input_tokens: 13, output_tokens: 0 } } }),
        "openai-compatible",
        RERANK_PATH
      );

      expect(result.usageMetrics).toEqual({ input_tokens: 13, output_tokens: 0 });
    }
  );

  it.each([
    null,
    [],
    7,
    "invalid",
    {},
    { search_units: 1 },
    { input_tokens: -1, total_tokens: "2" },
  ])("falls back to raw meta.tokens when billed token usage is unavailable: %j", (billedUnits) => {
    const result = parseUsageFromResponseText(
      JSON.stringify({
        meta: { billed_units: billedUnits, tokens: { input_tokens: 19, output_tokens: 1 } },
      }),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ input_tokens: 19, output_tokens: 1 });
    expect(result.usageRecord).toEqual({ input_tokens: 19, output_tokens: 1 });
  });

  it("ignores invalid primary directional fields without suppressing valid standard aliases", () => {
    const result = parseUsageFromResponseText(
      JSON.stringify({
        usage: { input_tokens: -1, prompt_tokens: 12, output_tokens: "4", completion_tokens: 4 },
      }),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({ input_tokens: 12, output_tokens: 4 });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "12", true, null])(
    "rejects unsafe token counts in every supported source: %j",
    (count) => {
      const responses = [
        { usage: { input_tokens: count, output_tokens: count, total_tokens: count } },
        { usage: { prompt_tokens: count, completion_tokens: count, total_tokens: count } },
        {
          meta: {
            billed_units: { input_tokens: count, output_tokens: count, total_tokens: count },
          },
        },
        { meta: { tokens: { input_tokens: count, output_tokens: count } } },
      ];
      for (const response of responses) {
        expect(
          parseUsageFromResponseText(JSON.stringify(response), "openai-compatible", RERANK_PATH)
        ).toEqual({ usageRecord: null, usageMetrics: null });
      }
    }
  );

  it.each([
    '{"usage":{"total_tokens":1e400}}',
    '{"meta":{"billed_units":{"input_tokens":-1e400}}}',
    '{"meta":{"tokens":{"input_tokens":NaN}}}',
    '{"meta":{"tokens":{"input_tokens":Infinity}}}',
  ])("rejects non-finite JSON numbers and malformed numeric literals: %s", (responseText) => {
    expect(parseUsageFromResponseText(responseText, "openai-compatible", RERANK_PATH)).toEqual({
      usageRecord: null,
      usageMetrics: null,
    });
  });

  it("accepts the safe integer boundary without rounding", () => {
    const result = parseUsageFromResponseText(
      JSON.stringify({
        meta: { billed_units: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 } },
      }),
      "openai-compatible",
      RERANK_PATH
    );

    expect(result.usageMetrics).toEqual({
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 0,
    });
  });

  it.each([
    "",
    "not json",
    "null",
    "[]",
    "42",
    '{"meta":[]}',
    '{"usage":{},"meta":{"billed_units":{"search_units":1}}}',
    '{"results":[{"index":0,"relevance_score":0.9}]}',
  ])(
    "does not fabricate tokens from missing usage, search units, or malformed input: %s",
    (text) => {
      expect(parseUsageFromResponseText(text, "openai-compatible", RERANK_PATH)).toEqual({
        usageRecord: null,
        usageMetrics: null,
      });
    }
  );

  it.each(["/v1/rerank", "/V1/ReRank/", "/v1/rerank?example=1"])(
    "uses the existing endpoint normalization convention: %s",
    (pathname) => {
      expect(
        parseUsageFromResponseText('{"usage":{"total_tokens":7}}', "openai-compatible", pathname)
          .usageMetrics
      ).toEqual({ input_tokens: 7, output_tokens: 0 });
    }
  );

  it.each([undefined, "/v1/chat/completions", "/v1/embeddings", "/v1/rerank/extra", "/rerank"])(
    "does not infer rerank accounting outside its endpoint: %s",
    (pathname) => {
      const responseText = JSON.stringify({
        usage: { total_tokens: 41 },
        meta: { billed_units: { input_tokens: 80, output_tokens: 2 } },
      });
      expect(parseUsageFromResponseText(responseText, "openai-compatible", pathname)).toEqual({
        usageRecord: null,
        usageMetrics: null,
      });
    }
  );

  it.each([undefined, null, "claude", "codex", "gemini", "gemini-cli"])(
    "does not interpret rerank meta schemas for other provider types: %s",
    (providerType) => {
      expect(
        parseUsageFromResponseText(
          '{"usage":{"total_tokens":41},"meta":{"billed_units":{"input_tokens":80}}}',
          providerType,
          RERANK_PATH
        )
      ).toEqual({ usageRecord: null, usageMetrics: null });
    }
  );

  it("preserves ordinary chat usage and existing cache-bucket accounting", () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    };
    const responseText = JSON.stringify({
      usage,
      meta: { billed_units: { input_tokens: 999, output_tokens: 999 } },
    });
    const expected = {
      input_tokens: 70,
      output_tokens: 7,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    };

    expect(parseUsageFromResponseText(responseText, "openai-compatible")).toEqual({
      usageRecord: usage,
      usageMetrics: expected,
    });
    expect(
      parseUsageFromResponseText(responseText, "openai-compatible", "/v1/chat/completions")
    ).toEqual({ usageRecord: usage, usageMetrics: expected });
  });
});

describe("rerank usage in existing cost accounting", () => {
  const tokenPrice = { input_cost_per_token: 2, output_cost_per_token: 10 };

  it.each([
    { response: { meta: { billed_units: { input_tokens: 11, output_tokens: 3 } } }, cost: "52" },
    { response: { meta: { tokens: { input_tokens: 11, output_tokens: 0 } } }, cost: "22" },
    { response: { usage: { total_tokens: 11 } }, cost: "22" },
    { response: { meta: { billed_units: { total_tokens: 11 } } }, cost: "22" },
  ])(
    "enters the input/output cost path without generating output or double counting: %j",
    async ({ response, cost }) => {
      const session = await createPricingSession(tokenPrice);
      const responseText = JSON.stringify(response);
      const { usageMetrics } = parseUsageFromResponseText(
        responseText,
        "openai-compatible",
        session.requestUrl.pathname
      );
      const billable = await resolveBillableUsageMetricsForCost(
        session,
        null,
        usageMetrics,
        200,
        responseText
      );

      expect(billable).toEqual(usageMetrics);
      expect(billable).not.toBeNull();
      expect(calculateRequestCost(billable!, tokenPrice).toString()).toBe(cost);
      expect(session.getResolvedPricingByBillingSource).not.toHaveBeenCalled();
    }
  );

  it("retains per-request pricing for successful search-units-only responses", async () => {
    const price = { ...tokenPrice, input_cost_per_request: 0.25 };
    const session = await createPricingSession(price);
    const responseText = '{"meta":{"billed_units":{"search_units":2}},"results":[]}';
    const { usageMetrics } = parseUsageFromResponseText(
      responseText,
      "openai-compatible",
      RERANK_PATH
    );
    const billable = await resolveBillableUsageMetricsForCost(
      session,
      null,
      usageMetrics,
      200,
      responseText
    );

    expect(usageMetrics).toBeNull();
    expect(billable).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(calculateRequestCost(billable!, price).toString()).toBe("0.25");
  });

  it("does not fabricate token billing without usage or a configured per-request price", async () => {
    const session = await createPricingSession(tokenPrice);
    const responseText = '{"meta":{"billed_units":{"search_units":1}},"results":[]}';
    const { usageMetrics } = parseUsageFromResponseText(
      responseText,
      "openai-compatible",
      RERANK_PATH
    );

    expect(
      await resolveBillableUsageMetricsForCost(session, null, usageMetrics, 200, responseText)
    ).toBeNull();
  });

  it("retains the existing fake-200 error billing guard even with rerank tokens", async () => {
    const session = await createPricingSession(tokenPrice);
    const responseText = JSON.stringify({
      error: { message: "The upstream could not complete reranking.", type: "server_error" },
      meta: { billed_units: { input_tokens: 11 } },
    });
    const { usageMetrics } = parseUsageFromResponseText(
      responseText,
      "openai-compatible",
      RERANK_PATH
    );

    expect(usageMetrics).toEqual({ input_tokens: 11 });
    expect(
      await resolveBillableUsageMetricsForCost(session, null, usageMetrics, 200, responseText)
    ).toBeNull();
    expect(session.getResolvedPricingByBillingSource).not.toHaveBeenCalled();
  });
});
