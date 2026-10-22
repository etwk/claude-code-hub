import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";

const mocks = vi.hoisted(() => ({
  pickRandomProviderWithExclusion: vi.fn(),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(async () => {}),
  getCircuitState: vi.fn(() => "closed"),
  getProviderHealthInfo: vi.fn(async () => ({
    health: { failureCount: 0 },
    config: { failureThreshold: 3 },
  })),
  isHttp2Enabled: vi.fn(async () => false),
  getPreferredProviderEndpoints: vi.fn(async () => []),
  getEndpointFilterStats: vi.fn(async () => null),
  recordEndpointSuccess: vi.fn(async () => {}),
  recordEndpointFailure: vi.fn(async () => {}),
  isVendorTypeCircuitOpen: vi.fn(async () => false),
  recordVendorTypeAllEndpointsTimeout: vi.fn(async () => {}),
  categorizeErrorAsync: vi.fn(async () => 0),
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

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    isHttp2Enabled: mocks.isHttp2Enabled,
  };
});

vi.mock("@/lib/provider-endpoints/endpoint-selector", () => ({
  getPreferredProviderEndpoints: mocks.getPreferredProviderEndpoints,
  getEndpointFilterStats: mocks.getEndpointFilterStats,
}));

vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointSuccess: mocks.recordEndpointSuccess,
  recordEndpointFailure: mocks.recordEndpointFailure,
}));

vi.mock("@/lib/circuit-breaker", () => ({
  getCircuitState: mocks.getCircuitState,
  getProviderHealthInfo: mocks.getProviderHealthInfo,
  recordFailure: mocks.recordFailure,
  recordSuccess: mocks.recordSuccess,
}));

vi.mock("@/lib/vendor-type-circuit-breaker", () => ({
  isVendorTypeCircuitOpen: mocks.isVendorTypeCircuitOpen,
  recordVendorTypeAllEndpointsTimeout: mocks.recordVendorTypeAllEndpointsTimeout,
}));

vi.mock("@/repository/message", () => ({
  updateMessageRequestDetails: vi.fn(async () => {}),
}));

vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: {
    pickRandomProviderWithExclusion: mocks.pickRandomProviderWithExclusion,
  },
}));

vi.mock("@/app/v1/_lib/proxy/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/proxy/errors")>();
  return {
    ...actual,
    categorizeErrorAsync: mocks.categorizeErrorAsync,
  };
});

import { ErrorCategory, ProxyError } from "@/app/v1/_lib/proxy/errors";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "p1",
    url: "https://provider.example.com",
    key: "k",
    providerVendorId: null,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: null,
    providerType: "claude",
    preserveClientIp: false,
    modelRedirects: null,
    allowedModels: null,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: 1,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 30_000,
    streamingIdleTimeoutMs: 10_000,
    requestTimeoutNonStreamingMs: 1_000,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    geminiGoogleSearchPreference: null,
    tpm: 0,
    rpm: 0,
    rpd: 0,
    cc: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function createSession(): ProxySession {
  const headers = new Headers();
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://example.com/v1/messages"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: "claude-test",
      log: "(test)",
      message: {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      },
    },
    userAgent: null,
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: "claude",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    specialSettings: [],
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    endpointPolicy: resolveEndpointPolicy("/v1/messages"),
    isHeaderModified: () => false,
  });

  return session as ProxySession;
}

describe("ProxyForwarder terminal safe client message candidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("carries final safe upstream candidate on generic 503 fallback", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", maxRetryAttempts: 1 });
    const provider2 = createProvider({ id: 2, name: "p2", maxRetryAttempts: 1 });
    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion
      .mockResolvedValueOnce(provider2)
      .mockResolvedValueOnce(null);
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.PROVIDER_ERROR);

    const doForward = vi.spyOn(
      ProxyForwarder as unknown as { doForward: (...args: unknown[]) => Promise<Response> },
      "doForward"
    );

    doForward
      .mockRejectedValueOnce(
        new ProxyError("Provider returned 401: invalid key", 401, {
          body: '{"error":"invalid_api_key"}',
          providerId: provider1.id,
          providerName: provider1.name,
        })
      )
      .mockRejectedValueOnce(
        new ProxyError("Provider returned 429: overload", 429, {
          body: "Quota exceeded for key [REDACTED_KEY]",
          rawBody: JSON.stringify({
            error: {
              message:
                "Quota exceeded for key sk-test-1234567890abcdef at https://api.vendor.example/v1/messages request_id=req_abc123",
            },
          }),
          providerId: provider2.id,
          providerName: provider2.name,
        })
      );

    const error = await ProxyForwarder.send(session).catch((rejection) => rejection as ProxyError);

    expect(error.statusCode).toBe(503);
    expect(error.message).toBe(
      "All providers are temporarily unavailable. Please try again later."
    );
    expect(error.upstreamError?.safeClientMessageCandidate).toContain("Quota exceeded");
    expect(error.upstreamError?.safeClientMessageCandidate).not.toContain("https://");
    expect(error.upstreamError?.safeClientMessageCandidate).not.toContain("req_abc123");
  });

  test("does not carry provider details when final candidate is unsafe", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", maxRetryAttempts: 1 });
    const provider2 = createProvider({ id: 2, name: "p2", maxRetryAttempts: 1 });
    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion
      .mockResolvedValueOnce(provider2)
      .mockResolvedValueOnce(null);
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.PROVIDER_ERROR);

    const doForward = vi.spyOn(
      ProxyForwarder as unknown as { doForward: (...args: unknown[]) => Promise<Response> },
      "doForward"
    );

    doForward
      .mockRejectedValueOnce(
        new ProxyError("Provider returned 500: internal", 500, {
          body: "Provider OpenAI returned: internal",
          providerId: provider1.id,
          providerName: provider1.name,
        })
      )
      .mockRejectedValueOnce(
        new ProxyError("Provider returned 500: overload", 500, {
          body: "Provider Anthropic returned: overload",
          providerId: provider2.id,
          providerName: provider2.name,
        })
      );

    const error = await ProxyForwarder.send(session).catch((rejection) => rejection as ProxyError);

    expect(error.statusCode).toBe(503);
    expect(error.upstreamError?.safeClientMessageCandidate).toBeUndefined();
  });

  test("passes through the original upstream ProxyError when only one provider is available", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", maxRetryAttempts: 3 });
    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(null);
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.PROVIDER_ERROR);

    const doForward = vi.spyOn(
      ProxyForwarder as unknown as { doForward: (...args: unknown[]) => Promise<Response> },
      "doForward"
    );

    const upstream400 = new ProxyError("Invalid value for temperature", 400, {
      body: JSON.stringify({ error: { message: "Invalid value for temperature" } }),
      rawBody: JSON.stringify({ error: { message: "Invalid value for temperature" } }),
      providerId: provider1.id,
      providerName: provider1.name,
    });
    doForward.mockRejectedValue(upstream400);

    const error = await ProxyForwarder.send(session).catch((rejection) => rejection as ProxyError);

    expect(doForward).toHaveBeenCalledTimes(1);
    expect(error).toBe(upstream400);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe("Invalid value for temperature");
    expect(mocks.recordFailure).toHaveBeenCalledTimes(1);
  });

  test("keeps generic 503 fallback when single-provider failure is an internal concurrency or discovery error", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", maxRetryAttempts: 1 });
    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(null);
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.PROVIDER_ERROR);

    const doForward = vi.spyOn(
      ProxyForwarder as unknown as { doForward: (...args: unknown[]) => Promise<Response> },
      "doForward"
    );
    const concurrencyError = new ProxyError("供应商并发 Session 上限已达到（10/10）", 503);
    doForward.mockRejectedValueOnce(concurrencyError);

    const resolved = await ProxyForwarder.send(session).catch(
      (rejection) => rejection as ProxyError
    );

    expect(resolved).not.toBe(concurrencyError);
    expect(resolved.statusCode).toBe(503);
    expect(resolved.message).toBe(
      "All providers are temporarily unavailable. Please try again later."
    );
    expect(resolved.upstreamError?.safeClientMessageCandidate).toBeUndefined();
  });

  test("keeps generic 503 fallback when single-provider failure is a local 524 timeout error", async () => {
    const provider1 = createProvider({ id: 1, name: "p1", maxRetryAttempts: 1 });
    const session = createSession();
    session.setProvider(provider1);

    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(null);
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.SYSTEM_ERROR);

    const doForward = vi.spyOn(
      ProxyForwarder as unknown as { doForward: (...args: unknown[]) => Promise<Response> },
      "doForward"
    );
    const timeoutError = new ProxyError(
      "Provider response timeout: closed after 30s without completing response",
      524
    );
    doForward.mockRejectedValueOnce(timeoutError);

    const resolved = await ProxyForwarder.send(session).catch(
      (rejection) => rejection as ProxyError
    );

    expect(resolved).not.toBe(timeoutError);
    expect(resolved.statusCode).toBe(503);
    expect(resolved.message).toBe(
      "All providers are temporarily unavailable. Please try again later."
    );
    expect(resolved.upstreamError?.safeClientMessageCandidate).toBeUndefined();

    const upstream524 = await ProxyError.fromUpstreamResponse(
      new Response(JSON.stringify({ error: { message: "Origin server timed out" } }), {
        status: 524,
        headers: { "content-type": "application/json", "x-request-id": "req_cf_524" },
      }),
      { id: provider1.id, name: provider1.name }
    );
    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(null);
    doForward.mockRejectedValueOnce(upstream524);
    const resolvedUpstream524 = await ProxyForwarder.send(session).catch(
      (rejection) => rejection as ProxyError
    );
    expect(resolvedUpstream524).toBe(upstream524);
    expect(resolvedUpstream524.statusCode).toBe(524);

    const upstream499 = await ProxyError.fromUpstreamResponse(
      new Response(JSON.stringify({ error: { message: "Upstream cancelled request" } }), {
        status: 499,
        headers: { "content-type": "application/json", "x-request-id": "req_499" },
      }),
      { id: provider1.id, name: provider1.name }
    );
    mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(null);
    doForward.mockRejectedValueOnce(upstream499);
    const resolvedUpstream499 = await ProxyForwarder.send(session).catch(
      (rejection) => rejection as ProxyError
    );
    expect(resolvedUpstream499).toBe(upstream499);
    expect(resolvedUpstream499.statusCode).toBe(499);
  });

  test("passes through upstream error when an earlier provider was skipped before dispatch", async () => {
    const provider1 = createProvider({
      id: 1,
      name: "p1",
      providerVendorId: 10,
      maxRetryAttempts: 1,
    });
    const provider2 = createProvider({
      id: 2,
      name: "p2",
      maxRetryAttempts: 1,
    });
    const session = createSession();
    session.setProvider(provider1);

    mocks.isVendorTypeCircuitOpen.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.pickRandomProviderWithExclusion
      .mockResolvedValueOnce(provider2)
      .mockResolvedValueOnce(null);
    mocks.categorizeErrorAsync.mockResolvedValue(ErrorCategory.PROVIDER_ERROR);

    const doForward = vi.spyOn(
      ProxyForwarder as unknown as { doForward: (...args: unknown[]) => Promise<Response> },
      "doForward"
    );
    const upstream400 = new ProxyError("Invalid value for temperature", 400, {
      body: JSON.stringify({ error: { message: "Invalid value for temperature" } }),
      rawBody: JSON.stringify({ error: { message: "Invalid value for temperature" } }),
      providerId: provider2.id,
      providerName: provider2.name,
    });
    doForward.mockRejectedValueOnce(upstream400);

    const resolved = await ProxyForwarder.send(session).catch(
      (rejection) => rejection as ProxyError
    );

    expect(doForward).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(upstream400);
    expect(resolved.statusCode).toBe(400);

    // Also preserves the dispatched error when a subsequent provider fails setup
    const session2 = createSession();
    session2.setProvider(provider2);
    mocks.isVendorTypeCircuitOpen.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.pickRandomProviderWithExclusion
      .mockResolvedValueOnce(provider1)
      .mockResolvedValueOnce(null);
    doForward.mockRejectedValueOnce(upstream400);

    const resolvedAfterLaterSetupFailure = await ProxyForwarder.send(session2).catch(
      (rejection) => rejection as ProxyError
    );
    expect(resolvedAfterLaterSetupFailure).toBe(upstream400);
    expect(resolvedAfterLaterSetupFailure.statusCode).toBe(400);
  });
});
