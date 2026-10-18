import { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseUsageFromResponseText,
  resolveBillableUsageMetricsForCost,
} from "@/app/v1/_lib/proxy/response-handler";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { calculateRequestCost } from "@/lib/utils/cost-calculation";
import type { ModelPriceData } from "@/types/model-price";

vi.mock("@/lib/config/system-settings-cache", () => ({
  getCachedSystemSettings: vi.fn(async () => ({ billNonSuccessfulRequests: false })),
}));

const SYSTEMONE_PATH = "/v1/systemone";

function parseSystemOneResponse(response: unknown) {
  return parseUsageFromResponseText(JSON.stringify(response), "openai-compatible", SYSTEMONE_PATH);
}

async function createPricingSession(priceData: ModelPriceData | null): Promise<ProxySession> {
  const request = new Request(`https://hub.example${SYSTEMONE_PATH}`, {
    body: JSON.stringify({
      model: "jev-1.13.0",
      state: "A customer requested a refund.",
      questions: { billing: { type: "noul", instructions: "Is this about billing?" } },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const session = await ProxySession.fromContext(new Context(request));
  vi.spyOn(session, "getResolvedPricingByBillingSource").mockResolvedValue(
    priceData
      ? {
          priceData,
          resolvedModelName: "jev-1.13.0",
          resolvedPricingProviderKey: "typesafe",
          source: "official_fallback",
        }
      : null
  );
  return session;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("System One usage parsing", () => {
  it.each([
    { input_tokens: 23, output_tokens: 2 },
    { prompt_tokens: 23, completion_tokens: 2 },
    { input_tokens: 23, prompt_tokens: 91, output_tokens: 2, completion_tokens: 19 },
    { input_tokens: 23, completion_tokens: 2 },
    { prompt_tokens: 23, output_tokens: 2 },
  ])("reads native and alias directions with native precedence: %j", (usage) => {
    const result = parseSystemOneResponse({
      model: "jev-1.13.0",
      answers: { billing: { type: "noul", noul: 0.98 } },
      usage,
    });

    expect(result).toEqual({
      usageMetrics: { input_tokens: 23, output_tokens: 2 },
      usageRecord: usage,
    });
  });

  it.each([
    { input_tokens: null, prompt_tokens: 12, output_tokens: null, completion_tokens: 4 },
    { input_tokens: -1, prompt_tokens: 12, output_tokens: "4", completion_tokens: 4 },
    {
      input_tokens: Number.MAX_SAFE_INTEGER + 1,
      prompt_tokens: 12,
      output_tokens: 0.5,
      completion_tokens: 4,
    },
  ])("does not let invalid native counts hide valid aliases: %j", (usage) => {
    expect(parseSystemOneResponse({ usage })).toEqual({
      usageMetrics: { input_tokens: 12, output_tokens: 4 },
      usageRecord: usage,
    });
  });

  it.each([
    { usage: { input_tokens: 8, output_tokens: null }, expected: { input_tokens: 8 } },
    { usage: { input_tokens: null, output_tokens: 3 }, expected: { output_tokens: 3 } },
    { usage: { prompt_tokens: 8, completion_tokens: null }, expected: { input_tokens: 8 } },
    { usage: { prompt_tokens: null, completion_tokens: 3 }, expected: { output_tokens: 3 } },
  ])(
    "retains a valid direction when its counterpart is nullable: $usage",
    ({ usage, expected }) => {
      expect(parseSystemOneResponse({ usage })).toEqual({
        usageMetrics: expected,
        usageRecord: usage,
      });
    }
  );

  it.each([
    { input_tokens: 0 },
    { input_tokens: 0, output_tokens: null },
    { input_tokens: 0, prompt_tokens: 50, total_tokens: 100 },
    { prompt_tokens: 0, total_tokens: 100 },
  ])("preserves authoritative input zero without inferring input from total: %j", (usage) => {
    expect(parseSystemOneResponse({ usage })).toEqual({
      usageMetrics: { input_tokens: 0 },
      usageRecord: usage,
    });
  });

  it.each([
    {
      input_tokens: 0,
      prompt_tokens: 50,
      output_tokens: 0,
      completion_tokens: 9,
      total_tokens: 100,
    },
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 100 },
    { input_tokens: 0, output_tokens: 0 },
  ])("preserves both explicit zero directions over aliases and totals: %j", (usage) => {
    expect(parseSystemOneResponse({ usage })).toEqual({
      usageMetrics: { input_tokens: 0, output_tokens: 0 },
      usageRecord: usage,
    });
  });

  it.each([
    { total_tokens: 41 },
    { total_tokens: 41, output_tokens: 0 },
    { total_tokens: 41, completion_tokens: 0 },
    { total_tokens: 41, input_tokens: null, output_tokens: null },
    { total_tokens: 41, prompt_tokens: null, completion_tokens: null },
    { total_tokens: 41, output_tokens: 0, completion_tokens: 9 },
  ])("maps a total without input or positive output to input only: %j", (usage) => {
    const result = parseSystemOneResponse({ usage });

    expect(result).toEqual({
      usageMetrics: { input_tokens: 41, output_tokens: 0 },
      usageRecord: usage,
    });
    expect(result.usageRecord).not.toHaveProperty("input_tokens", 41);
  });

  it("accepts an explicit zero total without fabricating positive usage", () => {
    expect(parseSystemOneResponse({ usage: { total_tokens: 0 } })).toEqual({
      usageMetrics: { input_tokens: 0, output_tokens: 0 },
      usageRecord: { total_tokens: 0 },
    });
  });

  it.each([
    { output_tokens: 3 },
    { output_tokens: 3, total_tokens: 41 },
    { input_tokens: null, output_tokens: 3, total_tokens: 41 },
    { completion_tokens: 3, total_tokens: 41 },
    { output_tokens: 3, total_tokens: 1 },
  ])("never invents an input split from positive output and a total: %j", (usage) => {
    expect(parseSystemOneResponse({ usage })).toEqual({
      usageMetrics: { output_tokens: 3 },
      usageRecord: usage,
    });
  });

  it.each([
    undefined,
    null,
    [],
    7,
    "invalid",
    {},
    { input_tokens: null, output_tokens: null },
    { prompt_tokens: null, completion_tokens: null },
    { output_tokens: 0 },
    { completion_tokens: 0 },
    { input_tokens: null, output_tokens: 0 },
    { input_tokens: -1, output_tokens: 0 },
    { search_units: 1 },
  ])("leaves absent or incomplete usage eligible for per-request fallback: %j", (usage) => {
    expect(parseSystemOneResponse({ usage })).toEqual({ usageMetrics: null, usageRecord: null });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "12", true, false, null, [], {}])(
    "rejects invalid counts in every supported field: %j",
    (count) => {
      for (const field of [
        "input_tokens",
        "output_tokens",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
      ]) {
        expect(parseSystemOneResponse({ usage: { [field]: count } })).toEqual({
          usageMetrics: null,
          usageRecord: null,
        });
      }
    }
  );

  it("does not discard a valid direction because other fields are invalid", () => {
    const usage = { input_tokens: 12, output_tokens: -1, total_tokens: "15" };

    expect(parseSystemOneResponse({ usage })).toEqual({
      usageMetrics: { input_tokens: 12 },
      usageRecord: usage,
    });
  });

  it.each(["input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens"])(
    "accepts the safe integer boundary for %s without rounding",
    (field) => {
      const usage = { [field]: Number.MAX_SAFE_INTEGER };
      const expected =
        field === "total_tokens"
          ? { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }
          : field === "input_tokens" || field === "prompt_tokens"
            ? { input_tokens: Number.MAX_SAFE_INTEGER }
            : { output_tokens: Number.MAX_SAFE_INTEGER };

      expect(parseSystemOneResponse({ usage })).toEqual({
        usageMetrics: expected,
        usageRecord: usage,
      });
    }
  );

  it.each([
    "",
    "not json",
    "null",
    "[]",
    "42",
    '"usage"',
    '{"usage":',
    '{"usage":{"input_tokens":NaN}}',
    '{"usage":{"output_tokens":Infinity}}',
    '{"usage":{"input_tokens":1e400}}',
    '{"usage":{"completion_tokens":-1e400}}',
    '{"usage":{"total_tokens":1e400}}',
    'data: {"usage":{"input_tokens":12,"output_tokens":3}}\n\n',
  ])("does not fabricate native non-streaming usage from malformed bodies: %s", (text) => {
    expect(parseUsageFromResponseText(text, "openai-compatible", SYSTEMONE_PATH)).toEqual({
      usageMetrics: null,
      usageRecord: null,
    });
  });

  it.each([
    { meta: { billed_units: { input_tokens: 80, output_tokens: 2 } } },
    { meta: { billed_units: { total_tokens: 82, search_units: 1 } } },
    { meta: { tokens: { input_tokens: 80, output_tokens: 2 } } },
    {
      usage: { input_tokens: null, output_tokens: 0 },
      meta: {
        billed_units: { input_tokens: 80, output_tokens: 2 },
        tokens: { input_tokens: 90, output_tokens: 3 },
      },
    },
  ])("does not interpret Cohere rerank metadata as System One usage: %j", (response) => {
    expect(parseSystemOneResponse(response)).toEqual({ usageMetrics: null, usageRecord: null });
  });

  it("preserves the raw usage report without merging, normalizing, or dropping opaque fields", () => {
    const usage = {
      input_tokens: null,
      output_tokens: 0,
      completion_tokens: 9,
      total_tokens: 41,
      extra: { _source: "typesafe", labels: ["inference"] },
      prompt_tokens_details: { cached_tokens: 7 },
    };
    const response = {
      model: "jev-1.13.0",
      usage,
      meta: { billed_units: { input_tokens: 99, output_tokens: 99 } },
    };
    const original = structuredClone(response);
    const result = parseSystemOneResponse(response);

    expect(result).toEqual({
      usageMetrics: { input_tokens: 41, output_tokens: 0 },
      usageRecord: usage,
    });
    expect(result.usageRecord).not.toHaveProperty("prompt_tokens");
    expect(response).toEqual(original);
  });

  it.each(["/v1/systemone", "/V1/SystemOne/", "/v1/systemone?trace=1"])(
    "normalizes the System One endpoint: %s",
    (pathname) => {
      expect(
        parseUsageFromResponseText('{"usage":{"total_tokens":7}}', "openai-compatible", pathname)
      ).toEqual({
        usageMetrics: { input_tokens: 7, output_tokens: 0 },
        usageRecord: { total_tokens: 7 },
      });
    }
  );

  it.each([
    undefined,
    "/v1/chat/completions",
    "/v1/embeddings",
    "/v1/responses",
    "/v1/systemone/extra",
    "/v1/systemone-archive",
    "/systemone",
    "/api/systemone",
  ])("does not infer System One totals outside the endpoint: %s", (pathname) => {
    expect(
      parseUsageFromResponseText('{"usage":{"total_tokens":41}}', "openai-compatible", pathname)
    ).toEqual({ usageMetrics: null, usageRecord: null });
  });

  it.each([undefined, null, "claude", "anthropic", "codex", "gemini", "gemini-cli"])(
    "does not apply System One total inference to provider %s",
    (providerType) => {
      expect(
        parseUsageFromResponseText('{"usage":{"total_tokens":41}}', providerType, SYSTEMONE_PATH)
      ).toEqual({ usageMetrics: null, usageRecord: null });
    }
  );
});

describe("System One usage in existing cost accounting", () => {
  const tokenPrice = { input_cost_per_token: 2, output_cost_per_token: 10 };

  it.each([
    { usage: { input_tokens: 11, output_tokens: 3 }, cost: "52" },
    { usage: { prompt_tokens: 11, completion_tokens: 3 }, cost: "52" },
    { usage: { input_tokens: 11, output_tokens: 0, total_tokens: 99 }, cost: "22" },
    { usage: { total_tokens: 11 }, cost: "22" },
    { usage: { total_tokens: 11, output_tokens: 0 }, cost: "22" },
    { usage: { output_tokens: 3, total_tokens: 11 }, cost: "30" },
    { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 99 }, cost: "0" },
  ])(
    "bills only the parsed directions without double counting: $usage",
    async ({ usage, cost }) => {
      const session = await createPricingSession(tokenPrice);
      const responseText = JSON.stringify({ model: "jev-1.13.0", answers: {}, usage });
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

  it.each([
    {},
    { usage: { input_tokens: null, output_tokens: null } },
    { usage: { output_tokens: 0 } },
    { usage: { completion_tokens: 0 } },
    { meta: { billed_units: { input_tokens: 80 }, tokens: { input_tokens: 90 } } },
  ])("retains per-request pricing when native token usage is missing: %j", async (report) => {
    const price = { ...tokenPrice, input_cost_per_request: 0.25 };
    const session = await createPricingSession(price);
    const responseText = JSON.stringify({ model: "jev-1.13.0", answers: {}, ...report });
    const { usageMetrics } = parseUsageFromResponseText(
      responseText,
      "openai-compatible",
      SYSTEMONE_PATH
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
    expect(session.getResolvedPricingByBillingSource).toHaveBeenCalledWith(null);
  });

  it.each([null, tokenPrice])(
    "does not fabricate token billing without usage or per-request pricing: %j",
    async (price) => {
      const session = await createPricingSession(price);
      const responseText = '{"model":"jev-1.13.0","answers":{},"usage":{"output_tokens":0}}';
      const { usageMetrics } = parseUsageFromResponseText(
        responseText,
        "openai-compatible",
        SYSTEMONE_PATH
      );

      expect(
        await resolveBillableUsageMetricsForCost(session, null, usageMetrics, 200, responseText)
      ).toBeNull();
    }
  );

  it.each([400, 429, 500, 503])("does not bill failed upstream status %s", async (status) => {
    const price = { ...tokenPrice, input_cost_per_request: 0.25 };
    const session = await createPricingSession(price);
    for (const usage of [undefined, { input_tokens: 11, output_tokens: 3 }]) {
      const responseText = JSON.stringify({ error: { message: "System One failed" }, usage });
      const { usageMetrics } = parseUsageFromResponseText(
        responseText,
        "openai-compatible",
        SYSTEMONE_PATH
      );

      expect(
        await resolveBillableUsageMetricsForCost(session, null, usageMetrics, status, responseText)
      ).toBeNull();
    }
    expect(session.getResolvedPricingByBillingSource).not.toHaveBeenCalled();
  });

  it.each([undefined, { input_tokens: 11, output_tokens: 3 }])(
    "retains fake-200 error nonbilling with or without usage: %j",
    async (usage) => {
      const session = await createPricingSession({ ...tokenPrice, input_cost_per_request: 0.25 });
      const responseText = JSON.stringify({
        error: { message: "The upstream could not answer the questions.", type: "server_error" },
        usage,
      });
      const { usageMetrics } = parseUsageFromResponseText(
        responseText,
        "openai-compatible",
        SYSTEMONE_PATH
      );

      expect(
        await resolveBillableUsageMetricsForCost(session, null, usageMetrics, 200, responseText)
      ).toBeNull();
      expect(session.getResolvedPricingByBillingSource).not.toHaveBeenCalled();
    }
  );
});
