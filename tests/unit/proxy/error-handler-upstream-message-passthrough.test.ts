import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCachedSystemSettings: vi.fn(async () => ({
    verboseProviderError: false,
    passThroughUpstreamErrorMessage: true,
  })),
  getErrorOverrideAsync: vi.fn(async () => undefined),
}));

vi.mock("@/lib/config/system-settings-cache", () => ({
  getCachedSystemSettings: mocks.getCachedSystemSettings,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@/app/v1/_lib/proxy/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/errors")>();
  return {
    ...actual,
    getErrorOverrideAsync: mocks.getErrorOverrideAsync,
  };
});

import { ProxyErrorHandler } from "@/app/v1/_lib/proxy/error-handler";
import { ProxyError } from "@/app/v1/_lib/proxy/errors";

function createSession(): any {
  return {
    sessionId: "s_passthrough",
    messageContext: null,
    startTime: Date.now(),
    getProviderChain: () => [],
    getCurrentModel: () => null,
    getContext1mApplied: () => false,
    getGroupCostMultiplier: () => 1,
    provider: null,
  };
}

function createUpstreamError(overrides: Partial<NonNullable<ProxyError["upstreamError"]>> = {}) {
  return new ProxyError("FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY", 429, {
    body: "Quota exceeded for key [REDACTED_KEY]",
    providerId: 1,
    providerName: "Anthropic",
    requestId: "req_123",
    rawBody: JSON.stringify({
      error: {
        message:
          "Quota exceeded for key sk-test-1234567890abcdef at https://api.vendor.example/v1/messages request_id=req_abc123",
      },
    }),
    rawBodyTruncated: false,
    statusCodeInferred: true,
    statusCodeInferenceMatcherId: "rate_limit",
    ...overrides,
  });
}

describe("ProxyErrorHandler.handle - upstream message passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: false,
      passThroughUpstreamErrorMessage: true,
    });
    mocks.getErrorOverrideAsync.mockResolvedValue(undefined);
  });

  test("passes through sanitized upstream message when enabled", async () => {
    const res = await ProxyErrorHandler.handle(createSession(), createUpstreamError());

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.message).toContain("Quota exceeded");
    expect(body.error.message).toContain("(cch_session_id: s_passthrough)");
    expect(body.error.message).not.toContain("sk-test");
    expect(body.error.message).not.toContain("https://");
    expect(body.error.message).not.toContain("api.vendor.example");
    expect(body.error.message).not.toContain("req_abc123");
    expect(body.error.message).not.toContain("Anthropic");
    expect(body.error.details).toBeUndefined();
    expect(body.request_id).toBeUndefined();
  });

  test("uses generic fallback when passthrough disabled", async () => {
    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: false,
      passThroughUpstreamErrorMessage: false,
    });

    const res = await ProxyErrorHandler.handle(createSession(), createUpstreamError());

    const body = await res.json();
    expect(body.error.message).toContain("JSON body contains a non-empty `error.message`");
    expect(body.error.message).not.toContain("Quota exceeded");
    expect(body.error.message).not.toContain("Upstream detail:");
  });

  test("both toggles on: passthrough controls message and verbose controls details", async () => {
    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: true,
      passThroughUpstreamErrorMessage: true,
    });

    const res = await ProxyErrorHandler.handle(createSession(), createUpstreamError());
    const body = await res.json();

    expect(body.error.message).toContain("Quota exceeded");
    expect(body.error.details.upstreamError.kind).toBe("fake_200");
    expect(body.request_id).toBe("req_123");
  });

  test("passThrough=false + verbose=true keeps generic message but still returns details and request_id", async () => {
    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: true,
      passThroughUpstreamErrorMessage: false,
    });

    const res = await ProxyErrorHandler.handle(createSession(), createUpstreamError());
    const body = await res.json();

    expect(body.error.message).toContain("JSON body contains a non-empty `error.message`");
    expect(body.error.message).not.toContain("Quota exceeded");
    expect(body.error.details.upstreamError.kind).toBe("fake_200");
    expect(body.request_id).toBe("req_123");
  });

  test("override.response remains absolute priority", async () => {
    mocks.getErrorOverrideAsync.mockResolvedValue({
      statusCode: 451,
      response: {
        error: {
          type: "invalid_request_error",
          message: "custom override",
          code: "provider_unavailable",
        },
      },
    });

    const res = await ProxyErrorHandler.handle(createSession(), createUpstreamError());
    const body = await res.json();

    expect(res.status).toBe(451);
    expect(body.error.message).toBe("custom override (cch_session_id: s_passthrough)");
    expect(body.error.message).not.toContain("Quota exceeded");
  });

  test("override.response with empty message still respects passthrough resolver fallback", async () => {
    mocks.getErrorOverrideAsync.mockResolvedValue({
      statusCode: 451,
      response: {
        error: {
          type: "invalid_request_error",
          message: "",
          code: "provider_unavailable",
        },
      },
    });

    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: false,
      passThroughUpstreamErrorMessage: false,
    });

    const res = await ProxyErrorHandler.handle(createSession(), createUpstreamError());
    const body = await res.json();

    expect(res.status).toBe(451);
    expect(body.error.message).toContain("JSON body contains a non-empty `error.message`");
    expect(body.error.message).not.toContain("Quota exceeded");
    expect(body.error.message).not.toContain("Upstream detail:");
  });

  test("override.statusCode keeps override status but still resolves passthrough message", async () => {
    mocks.getErrorOverrideAsync.mockResolvedValue({ statusCode: 418, response: null });

    const res = await ProxyErrorHandler.handle(createSession(), createUpstreamError());
    const body = await res.json();

    expect(res.status).toBe(418);
    expect(body.error.message).toContain("Quota exceeded");
  });

  test("unsafe candidate falls back to generic client-safe message", async () => {
    const err = createUpstreamError({
      rawBody: undefined,
      body: "Provider Anthropic returned: overload",
      safeClientMessageCandidate: "Provider Anthropic returned: overload",
    });

    const res = await ProxyErrorHandler.handle(createSession(), err);
    const body = await res.json();

    expect(body.error.message).toContain("JSON body contains a non-empty `error.message`");
    expect(body.error.message).not.toContain("Provider Anthropic");
  });

  test("passThrough=false uses generic fallback for regular upstream ProxyError too", async () => {
    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: false,
      passThroughUpstreamErrorMessage: false,
    });

    const err = new ProxyError("Quota exceeded", 429, {
      body: "Quota exceeded",
      providerId: 1,
      providerName: "Anthropic",
      rawBody: JSON.stringify({ error: { message: "Quota exceeded" } }),
    });

    const res = await ProxyErrorHandler.handle(createSession(), err);
    const body = await res.json();

    expect(body.error.message).toContain(
      "Upstream service is rate limited. Please try again later."
    );
    expect(body.error.message).not.toContain("Quota exceeded");
  });

  test("passes through message from ProxyError.fromUpstreamResponse across Claude, Gemini array, and FastAPI formats", async () => {
    const claudeError = await ProxyError.fromUpstreamResponse(
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "model 'claude-3-5-sonnet-20241022' temperature must be between 0 and 1. See https://docs.anthropic.com/en/api/messages",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      ),
      { id: 1, name: "Anthropic" }
    );
    const claudeRes = await ProxyErrorHandler.handle(createSession(), claudeError);
    expect(claudeRes.status).toBe(400);
    const claudeBody = await claudeRes.json();
    expect(claudeBody.error.message).toContain(
      "model 'claude-3-5-sonnet-20241022' temperature must be between 0 and 1."
    );
    expect(claudeBody.error.message).not.toContain("anthropic.com");

    const geminiArrayError = await ProxyError.fromUpstreamResponse(
      new Response(
        JSON.stringify([
          {
            error: {
              code: 400,
              message: "Invalid argument: thinking_budget must be >= 1024",
              status: "INVALID_ARGUMENT",
            },
          },
        ]),
        { status: 400, headers: { "content-type": "text/plain" } }
      ),
      { id: 2, name: "Gemini" }
    );
    const geminiRes = await ProxyErrorHandler.handle(createSession(), geminiArrayError);
    expect(geminiRes.status).toBe(400);
    const geminiBody = await geminiRes.json();
    expect(geminiBody.error.message).toContain("Invalid argument: thinking_budget must be >= 1024");

    const fastApiError = await ProxyError.fromUpstreamResponse(
      new Response(JSON.stringify({ detail: [{ msg: "Field required: messages" }] }), {
        status: 422,
        headers: { "content-type": "application/problem+json" },
      }),
      { id: 3, name: "Relay" }
    );
    const fastApiRes = await ProxyErrorHandler.handle(createSession(), fastApiError);
    expect(fastApiRes.status).toBe(422);
    const fastApiBody = await fastApiRes.json();
    expect(fastApiBody.error.message).toContain("Field required: messages");
  });

  test("prefers sanitized upstream message over built-in default error rule template when passthrough is enabled", async () => {
    mocks.getErrorOverrideAsync.mockResolvedValue({
      statusCode: 400,
      isDefault: true,
      response: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Invalid request: Upstream returned 'Invalid request' (invalid parameters or format). Check the request content.",
        },
      },
    });

    const err = await ProxyError.fromUpstreamResponse(
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "Invalid request: tools.0.custom.input_schema is not valid JSON Schema",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      ),
      { id: 1, name: "Anthropic" }
    );

    const res = await ProxyErrorHandler.handle(createSession(), err);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain(
      "Invalid request: tools.0.custom.input_schema is not valid JSON Schema"
    );

    // When passthrough is disabled, falls back to the default rule's template message
    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: false,
      passThroughUpstreamErrorMessage: false,
    });
    const resDisabled = await ProxyErrorHandler.handle(createSession(), err);
    const bodyDisabled = await resDisabled.json();
    expect(bodyDisabled.error.message).toContain(
      "Invalid request: Upstream returned 'Invalid request'"
    );

    // Local ProxyError without upstreamError keeps the default rule's localized message
    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: false,
      passThroughUpstreamErrorMessage: true,
    });
    const localErr = new ProxyError("Invalid request: image multipart metadata is missing.", 400);
    const resLocal = await ProxyErrorHandler.handle(createSession(), localErr);
    const bodyLocal = await resLocal.json();
    expect(bodyLocal.error.message).toContain(
      "Invalid request: Upstream returned 'Invalid request'"
    );

    // Non-English upstream text keeps the default rule's English override message
    mocks.getErrorOverrideAsync.mockResolvedValue({
      statusCode: 400,
      isDefault: true,
      response: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Model name cannot be empty. Specify a model parameter in the request.",
        },
      },
    });
    const nonEnglishUpstreamErr = await ProxyError.fromUpstreamResponse(
      new Response(JSON.stringify({ error: { message: "模型名称不能为空" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      { id: 1, name: "Anthropic" }
    );
    const resNonEnglish = await ProxyErrorHandler.handle(createSession(), nonEnglishUpstreamErr);
    const bodyNonEnglish = await resNonEnglish.json();
    expect(bodyNonEnglish.error.message).toContain(
      "Model name cannot be empty. Specify a model parameter in the request."
    );
  });

  test("ProxyError.fromUpstreamResponse bounds rawBody to 4096 chars and extracts nested error.detail", async () => {
    const largeBody = `plain error prefix ${"x".repeat(5000)}`;
    const err = await ProxyError.fromUpstreamResponse(new Response(largeBody, { status: 502 }), {
      id: 1,
      name: "Anthropic",
    });

    expect(err.upstreamError?.rawBody?.length).toBe(4096);
    expect(err.upstreamError?.rawBodyTruncated).toBe(true);

    const largeSniffedJsonBody = JSON.stringify({
      error: { message: `bad ${"x".repeat(5000)}` },
    });
    const largeSniffedErr = await ProxyError.fromUpstreamResponse(
      new Response(largeSniffedJsonBody, {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
      { id: 1, name: "Anthropic" }
    );
    expect(largeSniffedErr.upstreamError?.parsed).toBeUndefined();
    expect(largeSniffedErr.upstreamError?.body.length).toBe(503);
    const nestedDetailErr = await ProxyError.fromUpstreamResponse(
      new Response(JSON.stringify({ error: { detail: "invalid field" } }), {
        status: 422,
        headers: { "content-type": "application/json", "x-request-id": "req_nested_422" },
      }),
      { id: 1, name: "Anthropic" }
    );
    const resNested = await ProxyErrorHandler.handle(createSession(), nestedDetailErr);
    const bodyNested = await resNested.json();
    expect(resNested.status).toBe(422);
    expect(bodyNested.error.message).toContain("invalid field");
    expect(bodyNested.request_id).toBe("req_nested_422");
  });
});
