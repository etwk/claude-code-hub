/**
 * Regression test for model redirect across provider fallback.
 *
 * Behavioral contract:
 *   - When a request falls back from Provider A to Provider B, Provider B's
 *     redirect rules must match against the user's ORIGINAL pre-redirect model
 *     (NOT against the model Provider A rewrote it to).
 *   - If Provider B has no rule for the original model, request.model must be
 *     reset back to the original model before forwarding.
 *
 * This file documents the contract and pins it as a regression test, since the
 * "redirect leaks across fallback" complaint is hard to reproduce in production.
 */

import { describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ModelRedirector } from "@/app/v1/_lib/proxy/model-redirector";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

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
    firstByteTimeoutStreamingMs: 100,
    streamingIdleTimeoutMs: 0,
    requestTimeoutNonStreamingMs: 0,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    codexServiceTierPreference: null,
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

function createSession(initialModel: string): ProxySession {
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
      model: initialModel,
      log: "(test)",
      message: {
        model: initialModel,
        stream: true,
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
    sessionId: "sess-fallback-test",
    requestSequence: 1,
    originalFormat: "claude",
    providerType: null,
    originalModelName: null,
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

describe("Model redirect across provider fallback", () => {
  const REQUESTED_MODEL = "claude-3-5-sonnet-20241022";
  const PROVIDER_A_REDIRECT = "glm-4.6";
  const PROVIDER_B_REDIRECT_FROM_ORIGINAL = "kimi-k2";

  test("Provider B redirect rule on the ORIGINAL model fires after Provider A failed", () => {
    const providerA = createProvider({
      id: 100,
      name: "A",
      modelRedirects: [
        { matchType: "exact", source: REQUESTED_MODEL, target: PROVIDER_A_REDIRECT },
      ],
    });
    const providerB = createProvider({
      id: 200,
      name: "B",
      modelRedirects: [
        {
          matchType: "exact",
          source: REQUESTED_MODEL,
          target: PROVIDER_B_REDIRECT_FROM_ORIGINAL,
        },
      ],
    });

    const session = createSession(REQUESTED_MODEL);
    session.setProvider(providerA);
    session.addProviderToChain(providerA, { reason: "initial_selection" });

    // Provider A redirects "claude-3-5-sonnet" -> "glm-4.6"
    expect(ModelRedirector.apply(session, providerA)).toBe(true);
    expect(session.request.model).toBe(PROVIDER_A_REDIRECT);
    expect(session.getOriginalModel()).toBe(REQUESTED_MODEL);

    // Simulate Provider A failing -> fallback to Provider B
    session.setProvider(providerB);
    session.addProviderToChain(providerB, {
      reason: "retry_failed",
      attemptNumber: 2,
    });

    // Provider B's rule SHOULD match against the ORIGINAL model
    // (NOT against "glm-4.6" left in request.model from Provider A)
    expect(ModelRedirector.apply(session, providerB)).toBe(true);
    expect(session.request.model).toBe(PROVIDER_B_REDIRECT_FROM_ORIGINAL);
    expect(session.request.message.model).toBe(PROVIDER_B_REDIRECT_FROM_ORIGINAL);
    expect(session.getOriginalModel()).toBe(REQUESTED_MODEL);
  });

  test("Provider B redirect rule keyed on Provider A's REDIRECTED name does NOT fire", () => {
    // Common pitfall: someone configures Provider B with a rule like
    //   "glm-4.6 -> kimi-k2"
    // expecting it to chain after Provider A's redirect. The contract says no:
    // each provider matches against the user-requested model.
    const providerA = createProvider({
      id: 100,
      name: "A",
      modelRedirects: [
        { matchType: "exact", source: REQUESTED_MODEL, target: PROVIDER_A_REDIRECT },
      ],
    });
    const providerB = createProvider({
      id: 200,
      name: "B",
      modelRedirects: [{ matchType: "exact", source: PROVIDER_A_REDIRECT, target: "kimi-k2" }],
    });

    const session = createSession(REQUESTED_MODEL);
    session.setProvider(providerA);
    session.addProviderToChain(providerA, { reason: "initial_selection" });
    expect(ModelRedirector.apply(session, providerA)).toBe(true);
    expect(session.request.model).toBe(PROVIDER_A_REDIRECT);

    // Fallback to Provider B
    session.setProvider(providerB);
    session.addProviderToChain(providerB, {
      reason: "retry_failed",
      attemptNumber: 2,
    });
    // Provider B rule keyed on "glm-4.6" should NOT match because we're matching
    // the ORIGINAL "claude-3-5-sonnet" model, not "glm-4.6".
    expect(ModelRedirector.apply(session, providerB)).toBe(false);
    // Model must be reset to the original on Provider B
    expect(session.request.model).toBe(REQUESTED_MODEL);
    expect(session.request.message.model).toBe(REQUESTED_MODEL);
  });

  test("Provider B without redirect rules resets request.model to the original", () => {
    const providerA = createProvider({
      id: 100,
      name: "A",
      modelRedirects: [
        { matchType: "exact", source: REQUESTED_MODEL, target: PROVIDER_A_REDIRECT },
      ],
    });
    const providerB = createProvider({ id: 200, name: "B", modelRedirects: null });

    const session = createSession(REQUESTED_MODEL);
    session.setProvider(providerA);
    session.addProviderToChain(providerA, { reason: "initial_selection" });
    expect(ModelRedirector.apply(session, providerA)).toBe(true);
    expect(session.request.model).toBe(PROVIDER_A_REDIRECT);

    session.setProvider(providerB);
    session.addProviderToChain(providerB, {
      reason: "retry_failed",
      attemptNumber: 2,
    });
    expect(ModelRedirector.apply(session, providerB)).toBe(false);
    expect(session.request.model).toBe(REQUESTED_MODEL);
    // resetToOriginal also rewrites request.message.model — guard against
    // regressions that only reset request.model.
    expect(session.request.message.model).toBe(REQUESTED_MODEL);
  });

  test("Provider B redirects to a model different from Provider A's target", () => {
    // Both providers have rules on the original model but redirect to different targets.
    // The fallback path must select Provider B's target, not carry over Provider A's.
    const providerA = createProvider({
      id: 100,
      name: "A",
      modelRedirects: [{ matchType: "exact", source: REQUESTED_MODEL, target: "a-target" }],
    });
    const providerB = createProvider({
      id: 200,
      name: "B",
      modelRedirects: [{ matchType: "exact", source: REQUESTED_MODEL, target: "b-target" }],
    });

    const session = createSession(REQUESTED_MODEL);
    session.setProvider(providerA);
    session.addProviderToChain(providerA, { reason: "initial_selection" });
    expect(ModelRedirector.apply(session, providerA)).toBe(true);
    expect(session.request.model).toBe("a-target");

    session.setProvider(providerB);
    session.addProviderToChain(providerB, {
      reason: "retry_failed",
      attemptNumber: 2,
    });
    expect(ModelRedirector.apply(session, providerB)).toBe(true);
    expect(session.request.model).toBe("b-target");
    expect(session.request.message.model).toBe("b-target");

    // Original is preserved across both attempts (used for billing).
    expect(session.getOriginalModel()).toBe(REQUESTED_MODEL);
  });
});

describe("Gemini path rewrite after a regex redirect", () => {
  test("writes captured model text containing $ patterns into the path literally", () => {
    const provider = createProvider({
      providerType: "gemini",
      modelRedirects: [{ matchType: "regex", source: "^(.*)-fast$", target: "$1-pro" }],
    });
    const session = createSession("a$&b$1c$`d-fast");
    session.requestUrl = new URL(
      "https://example.com/v1beta/models/a$&b$1c$`d-fast:streamGenerateContent?alt=sse"
    );
    session.setProvider(provider);

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.request.model).toBe("a$&b$1c$`d-pro");
    expect(decodeURIComponent(session.requestUrl.pathname)).toBe(
      "/v1beta/models/a$&b$1c$`d-pro:streamGenerateContent"
    );
    expect(session.requestUrl.search).toBe("?alt=sse");
  });

  test("keeps a path without an action suffix", () => {
    const provider = createProvider({
      providerType: "gemini",
      modelRedirects: [
        { matchType: "exact", source: "gemini-2.5-flash", target: "gemini-2.5-pro" },
      ],
    });
    const session = createSession("gemini-2.5-flash");
    session.requestUrl = new URL("https://example.com/v1beta/models/gemini-2.5-flash");
    session.setProvider(provider);

    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini-2.5-pro");
  });
});

describe("Native Gemini model redirect consistency", () => {
  function createNativeSession(
    model: string,
    action: string,
    message: Record<string, unknown>
  ): ProxySession {
    const session = createSession(model);
    session.requestUrl = new URL(`https://example.com/v1beta/models/${model}:${action}`);
    session.request.message = message;
    session.request.buffer = new TextEncoder().encode(JSON.stringify(message)).buffer;
    session.originalFormat = "gemini";
    return session;
  }

  test("redirects and resets every batch embedding model without adding a top-level model", () => {
    const session = createNativeSession("embedding-a", "batchEmbedContents", {
      requests: [
        { model: "models/embedding-a", content: { parts: [{ text: "hi" }] } },
        { model: "embedding-a", content: { parts: [{ text: "bye" }] } },
      ],
    });
    const providerA = createProvider({
      providerType: "gemini",
      modelRedirects: [{ matchType: "exact", source: "embedding-a", target: "models/embedding-b" }],
    });
    const providerB = createProvider({ id: 2, providerType: "gemini", modelRedirects: null });

    expect(ModelRedirector.apply(session, providerA)).toBe(true);
    expect(session.request.model).toBe("embedding-b");
    expect(session.requestUrl.pathname).toBe("/v1beta/models/embedding-b:batchEmbedContents");
    expect(session.request.message).not.toHaveProperty("model");
    expect(JSON.parse(new TextDecoder().decode(session.request.buffer))).toEqual({
      requests: [
        { model: "models/embedding-b", content: { parts: [{ text: "hi" }] } },
        { model: "embedding-b", content: { parts: [{ text: "bye" }] } },
      ],
    });

    expect(ModelRedirector.apply(session, providerB)).toBe(false);
    expect(session.request.model).toBe("embedding-a");
    expect(session.requestUrl.pathname).toBe("/v1beta/models/embedding-a:batchEmbedContents");
    expect(JSON.parse(new TextDecoder().decode(session.request.buffer))).toEqual({
      requests: [
        { model: "models/embedding-a", content: { parts: [{ text: "hi" }] } },
        { model: "embedding-a", content: { parts: [{ text: "bye" }] } },
      ],
    });
  });

  test("fallback matches the routing baseline and rewrites countTokens nested models", () => {
    const session = createNativeSession("gemini-client", "countTokens", {
      generateContentRequest: { model: "models/gemini-client", contents: [] },
    });
    session.setOriginalModel("gemini-client");
    const providerA = createProvider({
      providerType: "gemini",
      modelRedirects: [{ matchType: "exact", source: "gemini-routing", target: "gemini-a" }],
    });
    const providerB = createProvider({
      id: 2,
      providerType: "gemini",
      modelRedirects: [{ matchType: "exact", source: "gemini-routing", target: "gemini-b" }],
    });

    expect(ModelRedirector.apply(session, providerA, "gemini-routing")).toBe(true);
    expect(session.request.message.generateContentRequest).toEqual({
      model: "models/gemini-a",
      contents: [],
    });
    expect(ModelRedirector.apply(session, providerB, "gemini-routing")).toBe(true);
    expect(session.request.model).toBe("gemini-b");
    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini-b:countTokens");
    expect(session.request.message.generateContentRequest).toEqual({
      model: "models/gemini-b",
      contents: [],
    });

    expect(
      ModelRedirector.apply(session, createProvider({ modelRedirects: null }), "gemini-routing")
    ).toBe(false);
    expect(session.request.model).toBe("gemini-routing");
    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini-routing:countTokens");
    expect(session.request.message.generateContentRequest).toEqual({
      model: "models/gemini-routing",
      contents: [],
    });
    expect(session.request.message).not.toHaveProperty("model");
    expect(session.getOriginalModel()).toBe("gemini-client");
  });

  test("preserves an unchanged path-only raw body buffer during a redirect", () => {
    const session = createNativeSession("gemini-a", "generateContent", { contents: [] });
    const buffer = new TextEncoder().encode('{ "contents" : [] }\n').buffer;
    session.request.buffer = buffer;
    const provider = createProvider({
      providerType: "gemini",
      modelRedirects: [{ matchType: "exact", source: "gemini-a", target: "gemini-b" }],
    });
    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.request.buffer).toBe(buffer);
    expect(session.request.message).toEqual({ contents: [] });
    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini-b:generateContent");
  });

  test("retains original JSON bytes when a native redirect target is already the routing model", () => {
    const session = createNativeSession("gemini-a", "generateContent", {
      model: "models/gemini-a",
      contents: [],
    });
    const buffer = new TextEncoder().encode(
      '{ "model": "models/gemini-a", "contents": [] }\n'
    ).buffer;
    session.request.buffer = buffer;
    const provider = createProvider({
      providerType: "gemini",
      modelRedirects: [{ matchType: "exact", source: "gemini-a", target: "models/gemini-a" }],
    });
    expect(ModelRedirector.apply(session, provider)).toBe(true);
    expect(session.request.buffer).toBe(buffer);
    expect(session.request.message.model).toBe("models/gemini-a");
    expect(session.request.model).toBe("gemini-a");
  });

  test("matches an explicit provider-filter input while preserving the client billing identity", () => {
    const session = createSession("client-model");
    session.setOriginalModel("client-model");
    const provider = createProvider({
      providerType: "openai-compatible",
      modelRedirects: [
        { matchType: "exact", source: "provider-filter-model", target: "target-model" },
      ],
    });
    expect(ModelRedirector.apply(session, provider, "provider-filter-model")).toBe(true);
    expect(session.request.message.model).toBe("target-model");
    expect(session.getOriginalModel()).toBe("client-model");
    expect(ModelRedirector.apply(session, createProvider(), "provider-filter-model")).toBe(false);
    expect(session.request.message.model).toBe("provider-filter-model");
    expect(session.getOriginalModel()).toBe("client-model");
  });
});
