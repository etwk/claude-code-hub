import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as ConfigModule from "@/lib/config";
import type { SpecialSetting, ThinkingConfigValue } from "@/types/special-settings";

const mocks = vi.hoisted(() => ({
  applyGlobal: vi.fn(async (_session: ProxySession) => {}),
  applyForProvider: vi.fn(async (_session: ProxySession) => {}),
  applyFinal: vi.fn(
    async (_session: unknown, _body: Record<string, unknown>, _headers: Headers) => {}
  ),
  updateMessageRequestDetails: vi.fn(async (_id: number, _details: Record<string, unknown>) => {}),
  storeSessionSpecialSettings: vi.fn(
    async (_sessionId: string, _settings: SpecialSetting[] | null, _sequence: number) => {}
  ),
  pickRandomProviderWithExclusion: vi.fn(async (): Promise<Provider | null> => null),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  isHttp2Enabled: vi.fn(async () => false),
  getCachedSystemSettings: vi.fn(async () => ({
    enableClaudeMetadataUserIdInjection: false,
    enableBillingHeaderRectifier: false,
    enableThinkingBudgetRectifier: true,
  })),
}));
vi.mock("@/lib/langfuse", () => ({ isLangfuseEnabled: vi.fn(() => false) }));
vi.mock("@/lib/proxy-agent", () => ({
  getProxyAgentForProvider: vi.fn(async () => null),
  getGlobalAgentPool: vi.fn(),
}));
vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: {
    applyGlobal: mocks.applyGlobal,
    applyForProvider: mocks.applyForProvider,
    applyFinal: mocks.applyFinal,
  },
}));
vi.mock("@/repository/message", () => ({
  updateMessageRequestDetails: mocks.updateMessageRequestDetails,
}));
vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    storeSessionSpecialSettings: mocks.storeSessionSpecialSettings,
    storeSessionRequestHeaders: vi.fn(async () => {}),
    storeSessionUpstreamRequestMeta: vi.fn(async () => {}),
    storeSessionRequestPhaseSnapshot: vi.fn(async () => {}),
    storeSessionResponsePhaseSnapshot: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/circuit-breaker", () => ({
  getCircuitState: vi.fn(() => "closed"),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(async () => {}),
  getProviderHealthInfo: vi.fn(async () => ({
    health: { failureCount: 0 },
    config: { failureThreshold: 3 },
  })),
}));
vi.mock("@/lib/provider-endpoints/endpoint-selector", () => ({
  getPreferredProviderEndpoints: vi.fn(async () => []),
  getEndpointFilterStats: vi.fn(async () => null),
}));
vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointSuccess: vi.fn(async () => {}),
  recordEndpointFailure: vi.fn(async () => {}),
}));
vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: {
    pickRandomProviderWithExclusion: mocks.pickRandomProviderWithExclusion,
    resolveEffectivePriorityForSession: (provider: Provider) => provider.priority ?? 0,
  },
}));
vi.mock("@/app/v1/_lib/responses-ws/eligibility", () => ({
  evaluateResponsesWsEligibility: vi.fn(async () => ({
    eligible: false,
    isWebsocketClient: false,
  })),
  getResponsesWsSessionId: vi.fn(() => null),
  isWebsocketClientRequest: vi.fn(() => false),
}));
vi.mock("@/app/v1/_lib/gemini/auth", () => ({
  GeminiAuth: { getAccessToken: vi.fn(async () => "upstream-key"), isApiKey: vi.fn(() => true) },
}));

import { tryFakeStreamingPath } from "@/app/v1/_lib/proxy/fake-streaming/proxy-integration";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxyRequestFilter } from "@/app/v1/_lib/proxy/request-filter";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { extractThinkingEffortInfo } from "@/lib/utils/thinking-effort";
import type { Provider } from "@/types/provider";
import type { SystemSettings } from "@/types/system-config";

const internals = ProxyForwarder as unknown as {
  doForward: (
    session: ProxySession,
    provider: Provider,
    baseUrl: string,
    endpointAudit?: { endpointId: number | null; endpointUrl: string },
    attemptNumber?: number,
    deferDetailSnapshotPersistence?: boolean,
    externalAbortSignal?: AbortSignal
  ) => Promise<Response>;
  fetchWithoutAutoDecode: (url: string, init: RequestInit) => Promise<Response>;
  createStreamingShadowSession: (session: ProxySession, provider: Provider) => ProxySession;
  syncWinningAttemptSession: (target: ProxySession, source: ProxySession) => void;
};

function createProvider(providerType: Provider["providerType"] = "claude", id = 1): Provider {
  return {
    id,
    name: `native-${id}`,
    providerType,
    url: "https://upstream.example.com",
    key: "upstream-key",
    preserveClientIp: false,
    priority: 0,
    maxRetryAttempts: 1,
    firstByteTimeoutStreamingMs: 0,
    requestTimeoutNonStreamingMs: 0,
    streamingIdleTimeoutMs: 0,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    modelRedirects: null,
  } as Provider;
}

function createSession(
  body: Record<string, unknown>,
  provider: Provider,
  retainBody = false
): ProxySession {
  const pathname = provider.providerType.startsWith("gemini")
    ? "/v1beta/models/gemini-test:generateContent"
    : "/v1/messages";
  const session = new (
    ProxySession as unknown as {
      new (init: {
        startTime: number;
        method: string;
        requestUrl: URL;
        headers: Headers;
        headerLog: string;
        request: { message: Record<string, unknown>; model: string; log: string };
        userAgent: null;
        context: unknown;
        clientAbortSignal: null;
      }): ProxySession;
    }
  )({
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL(`https://proxy.example.com${pathname}`),
    headers: new Headers({ "content-type": "application/json" }),
    headerLog: "",
    request: { message: body, model: "native-test", log: JSON.stringify(body) },
    userAgent: null,
    context: {},
    clientAbortSignal: null,
  });
  session.setProvider(provider);
  session.setAuthState({ success: true, user: null, key: null, apiKey: null });
  session.setOriginalFormat(provider.providerType.startsWith("gemini") ? "gemini" : "claude");
  session.setHighConcurrencyModeEnabled(!retainBody);
  session.setMessageContext({ id: 123 } as NonNullable<ProxySession["messageContext"]>);
  return session;
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg-native",
      type: "message",
      role: "assistant",
      model: "native-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } }
  );
}

function outgoingSettings(session: ProxySession) {
  return (
    session
      .getSpecialSettings()
      ?.filter((setting) => setting.type === "native_thinking_forwarded") ?? []
  );
}

function release(session: ProxySession): void {
  const runtime = session as ProxySession & {
    clearResponseTimeout?: () => void;
    releaseAgent?: () => void;
  };
  runtime.clearResponseTimeout?.();
  runtime.releaseAgent?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyGlobal.mockReset();
  mocks.applyGlobal.mockResolvedValue(undefined);
  mocks.applyForProvider.mockReset();
  mocks.applyForProvider.mockResolvedValue(undefined);
  mocks.applyFinal.mockReset();
  mocks.applyFinal.mockResolvedValue(undefined);
  mocks.updateMessageRequestDetails.mockReset();
  mocks.updateMessageRequestDetails.mockResolvedValue(undefined);
  mocks.pickRandomProviderWithExclusion.mockReset();
  mocks.pickRandomProviderWithExclusion.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("ProxyForwarder final native thinking observations", () => {
  test.each(["gemini", "gemini-cli"] as const)(
    "%s captures the final 8192 -> 0 budget without retaining the outgoing body",
    async (providerType) => {
      const provider = createProvider(providerType);
      const nativeRequest = { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } };
      const body = providerType === "gemini-cli" ? { request: nativeRequest } : nativeRequest;
      const session = createSession(body, provider);
      session.addSpecialSetting({
        type: "native_thinking",
        scope: "request",
        hit: true,
        protocol: "gemini",
        config: { effort: null, mode: null, budgetTokens: 8192 },
      });
      mocks.applyFinal.mockImplementationOnce(async (_session, outgoing) => {
        const request = (outgoing.request ?? outgoing) as typeof nativeRequest;
        request.generationConfig.thinkingConfig.thinkingBudget = 0;
      });
      const transport = vi.spyOn(internals, "fetchWithoutAutoDecode");
      transport.mockImplementationOnce(async (_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual(
          providerType === "gemini-cli"
            ? { request: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } } }
            : { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }
        );
        return okResponse();
      });

      await internals.doForward(session, provider, provider.url);
      release(session);

      expect(session.forwardedRequestBody).toBeNull();
      expect(nativeRequest.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);
      expect(outgoingSettings(session)).toEqual([
        {
          type: "native_thinking_forwarded",
          scope: "provider",
          hit: true,
          protocol: "gemini",
          providerId: provider.id,
          config: { effort: null, mode: null, budgetTokens: 0 },
        },
      ]);
      expect(extractThinkingEffortInfo(session.getSpecialSettings())).toEqual({
        source: "gemini",
        requested: { effort: null, mode: null, budgetTokens: 8192 },
        effective: { effort: null, mode: null, budgetTokens: 0 },
        isOverridden: true,
      });
    }
  );

  test.each(["claude", "claude-auth", "gemini", "gemini-cli"] as const)(
    "%s records explicit removal even when the upstream request fails",
    async (providerType) => {
      const provider = createProvider(providerType);
      const anthropic = providerType.startsWith("claude");
      const nativeBody = { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } };
      const body = anthropic
        ? { model: "native-test", thinking: { type: "enabled", budget_tokens: 8192 } }
        : providerType === "gemini-cli"
          ? { request: nativeBody }
          : nativeBody;
      const session = createSession(body, provider, true);
      session.sessionId = "native-session";
      const requested: ThinkingConfigValue = {
        effort: null,
        mode: anthropic ? "enabled" : null,
        budgetTokens: 8192,
      };
      session.addSpecialSetting({
        type: "native_thinking",
        scope: "request",
        hit: true,
        protocol: anthropic ? "anthropic" : "gemini",
        config: requested,
      });
      mocks.applyFinal.mockImplementationOnce(async (_session, outgoing) => {
        if (anthropic) delete outgoing.thinking;
        else delete ((outgoing.request ?? outgoing) as Record<string, unknown>).generationConfig;
      });
      vi.spyOn(internals, "fetchWithoutAutoDecode").mockImplementationOnce(async (_url, init) => {
        const outgoing = JSON.parse(String(init.body));
        expect(
          anthropic ? outgoing.thinking : (outgoing.request ?? outgoing).generationConfig
        ).toBeUndefined();
        return new Response('{"error":{"message":"unavailable"}}', { status: 503 });
      });

      await expect(internals.doForward(session, provider, provider.url)).rejects.toMatchObject({
        statusCode: 503,
      });

      expect(outgoingSettings(session)).toEqual([
        {
          type: "native_thinking_forwarded",
          scope: "provider",
          hit: true,
          protocol: anthropic ? "anthropic" : "gemini",
          providerId: provider.id,
          config: null,
        },
      ]);
      expect(mocks.storeSessionSpecialSettings).toHaveBeenLastCalledWith(
        "native-session",
        session.getSpecialSettings(),
        session.requestSequence
      );
      expect(extractThinkingEffortInfo(session.getSpecialSettings())).toEqual({
        source: anthropic ? "anthropic" : "gemini",
        requested,
        effective: null,
        isOverridden: true,
      });
    }
  );

  test.each(["claude", "gemini"] as const)(
    "%s observes native fields explicitly replaced with null",
    async (providerType) => {
      const provider = createProvider(providerType);
      const body =
        providerType === "claude"
          ? { thinking: { type: "enabled", budget_tokens: 8192 } }
          : { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } };
      const session = createSession(body, provider);
      mocks.applyFinal.mockImplementationOnce(async (_session, outgoing) => {
        if (providerType === "claude") outgoing.thinking = null;
        else (outgoing.generationConfig as Record<string, unknown>).thinkingConfig = null;
      });
      vi.spyOn(internals, "fetchWithoutAutoDecode").mockImplementationOnce(async (_url, init) => {
        const outgoing = JSON.parse(String(init.body));
        expect(
          providerType === "claude" ? outgoing.thinking : outgoing.generationConfig.thinkingConfig
        ).toBeNull();
        return okResponse();
      });

      await internals.doForward(session, provider, provider.url);
      release(session);

      expect(outgoingSettings(session)).toEqual([
        expect.objectContaining({ providerId: provider.id, config: null }),
      ]);
    }
  );

  test("stream requests persist the final native snapshot before receiving upstream content", async () => {
    const provider = createProvider();
    const session = createSession(
      {
        model: "native-test",
        stream: true,
        thinking: { type: "enabled", budget_tokens: 8192 },
      },
      provider
    );
    mocks.applyFinal.mockImplementationOnce(async (_session, outgoing) => {
      outgoing.thinking = { type: "disabled" };
    });
    vi.spyOn(internals, "fetchWithoutAutoDecode").mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init.body)).thinking).toEqual({ type: "disabled" });
      return new Response('data: {"type":"message_stop"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const response = await internals.doForward(session, provider, provider.url);
    await response.text();
    release(session);

    expect(session.forwardedRequestBody).toBeNull();
    expect(outgoingSettings(session)?.[0].config).toEqual({
      effort: null,
      mode: "disabled",
      budgetTokens: null,
    });
  });

  test("serial rectifier retries replace the outgoing snapshot and preserve persisted observations", async () => {
    const provider = createProvider();
    const session = createSession(
      {
        model: "native-test",
        max_tokens: 1000,
        thinking: { type: "enabled", budget_tokens: 500 },
        messages: [{ role: "user", content: "hi" }],
      },
      provider
    );
    const persisted: SpecialSetting[][] = [];
    mocks.updateMessageRequestDetails.mockImplementation(async (_id, details) => {
      if (Array.isArray(details.specialSettings)) persisted.push(details.specialSettings);
    });
    const transport = vi.spyOn(internals, "fetchWithoutAutoDecode");
    transport.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message:
              "thinking.enabled.budget_tokens: Input should be greater than or equal to 1024",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    );
    transport.mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init.body)).thinking.budget_tokens).toBe(32000);
      return okResponse();
    });

    const response = await ProxyForwarder.send(session);
    await response.text();
    release(session);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(outgoingSettings(session)).toHaveLength(1);
    expect(outgoingSettings(session)?.[0].config?.budgetTokens).toBe(32000);
    expect(
      persisted[0].find((setting) => setting.type === "native_thinking_forwarded")?.config
        ?.budgetTokens
    ).toBe(500);
    expect(persisted[0]).not.toBe(session.getSpecialSettings());
    expect(session.getSpecialSettings()).toContainEqual(
      expect.objectContaining({ type: "thinking_budget_rectifier", hit: true })
    );
  });

  test.each([
    { providerType: "claude", phase: "guard" },
    { providerType: "claude", phase: "final" },
    { providerType: "claude", phase: "both" },
    { providerType: "gemini", phase: "guard" },
    { providerType: "gemini", phase: "final" },
    { providerType: "gemini", phase: "both" },
  ] as const)(
    "$providerType keeps internal non-stream forwarding against $phase filters and later attempts",
    async ({ providerType, phase }) => {
      const provider = createProvider(providerType);
      const session = createSession(
        providerType === "gemini"
          ? { stream: true, contents: [{ role: "user", parts: [{ text: "hi" }] }] }
          : { model: "native-test", stream: true, messages: [{ role: "user", content: "hi" }] },
        provider
      );
      if (providerType === "gemini") {
        session.requestUrl = new URL(
          "https://proxy.example.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse&clientName=test"
        );
      }
      mocks.applyGlobal.mockImplementationOnce(async (value) => {
        value.request.message.model = "routing-test";
      });
      if (phase !== "final") {
        mocks.applyForProvider.mockImplementation(async (value) => {
          value.request.message.stream = true;
        });
      }
      if (phase !== "guard") {
        mocks.applyFinal.mockImplementation(async (_value, body) => {
          body.stream = true;
        });
      }

      await ProxyRequestFilter.ensure(session);
      expect(session.getOriginalModel()).toBe("native-test");
      expect(session.getRoutingModel()).toBe("routing-test");
      expect(session.request.message.stream).toBe(true);

      const transport = vi.spyOn(internals, "fetchWithoutAutoDecode");
      transport.mockImplementation(async (url, init) => {
        const outgoing = JSON.parse(String(init.body));
        expect(outgoing.stream).toBe(false);
        expect(outgoing.model).toBe("routing-test");
        expect(outgoing.providerOnly).toBeUndefined();
        expect(new Headers(init.headers).has("x-provider-only")).toBe(false);
        if (providerType === "gemini") {
          const target = new URL(url);
          expect(target.pathname).toBe("/v1beta/models/routing-test:generateContent");
          expect(target.searchParams.has("alt")).toBe(false);
          expect(target.searchParams.get("clientName")).toBe("test");
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "ok" }] },
                  finishReason: "STOP",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        return okResponse();
      });

      const response = await tryFakeStreamingPath(session, {
        fakeStreamingWhitelist: [{ model: "routing-test", groupTags: [] }],
      } as unknown as SystemSettings);
      expect(response).not.toBeNull();
      expect(response?.headers.get("content-type")).toContain("text/event-stream");
      expect(await response?.text()).toContain("ok");

      // Exercise the same real preparation boundary used by retry/fallback, without re-running
      // fake-streaming conversion: provider-local mutations must not enter the saved payload.
      session.request.message.stream = true;
      session.request.message.model = "provider-only";
      session.request.message.providerOnly = "must not survive";
      session.headers.set("x-provider-only", "must not survive");
      if (providerType === "gemini") {
        session.requestUrl.pathname = "/v1beta/models/provider-only:streamGenerateContent";
      }
      const nextProvider = createProvider(providerType, 2);
      session.setProvider(nextProvider);
      const retried = await internals.doForward(session, nextProvider, nextProvider.url);
      expect(await retried.text()).toContain("ok");
      release(session);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(session.getRoutingModel()).toBe("routing-test");
      expect(session.getOriginalModel()).toBe("native-test");
    }
  );

  test("fake streaming persists the final native body through the same forwarder", async () => {
    const provider = createProvider();
    const session = createSession(
      {
        model: "native-test",
        stream: true,
        thinking: { type: "enabled", budget_tokens: 8192 },
        messages: [{ role: "user", content: "hi" }],
      },
      provider
    );
    mocks.applyFinal.mockImplementationOnce(async (_session, outgoing) => {
      outgoing.thinking = { type: "disabled" };
    });
    vi.spyOn(internals, "fetchWithoutAutoDecode").mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init.body)).stream).toBe(false);
      expect(JSON.parse(String(init.body)).thinking).toEqual({ type: "disabled" });
      return okResponse();
    });

    const response = await tryFakeStreamingPath(session, {
      fakeStreamingWhitelist: [{ model: "native-test", groupTags: [] }],
    } as unknown as SystemSettings);
    expect(response).not.toBeNull();
    expect(await response?.text()).toContain("ok");
    expect(outgoingSettings(session)?.[0].config).toEqual({
      effort: null,
      mode: "disabled",
      budgetTokens: null,
    });
  });

  test.each(["claude", "claude-auth", "gemini", "gemini-cli"] as const)(
    "a cancelled %s preparation cannot replace the selected attempt's observation",
    async (providerType) => {
      const anthropic = !providerType.startsWith("gemini");
      const protocol = anthropic ? "anthropic" : "gemini";
      const provider = createProvider(providerType);
      const session = createSession(
        anthropic
          ? { model: "native-test", thinking: { type: "enabled", budget_tokens: 8192 } }
          : { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } },
        provider
      );
      const cancellation = new DOMException("Another provider won", "AbortError");
      const controller = new AbortController();
      let resumePreparation!: () => void;
      let notifyPreparing!: () => void;
      const preparing = new Promise<void>((resolve) => {
        notifyPreparing = resolve;
      });
      const preparation = new Promise<void>((resolve) => {
        resumePreparation = resolve;
      });
      mocks.applyFinal.mockImplementationOnce(async () => {
        notifyPreparing();
        await preparation;
      });
      const transport = vi.spyOn(internals, "fetchWithoutAutoDecode");
      const pending = internals.doForward(
        session,
        provider,
        provider.url,
        undefined,
        undefined,
        false,
        controller.signal
      );
      const rejected = expect(pending).rejects.toBe(cancellation);
      await preparing;

      const winningProvider = createProvider(providerType, 2);
      const winner = internals.createStreamingShadowSession(session, winningProvider);
      winner.recordNativeThinkingForwarded(protocol, winningProvider.id, {
        effort: null,
        mode: anthropic ? "enabled" : null,
        budgetTokens: 32000,
      });
      session.setProvider(winningProvider);
      internals.syncWinningAttemptSession(session, winner);
      controller.abort(cancellation);
      resumePreparation();
      await rejected;

      expect(outgoingSettings(session)).toEqual([
        expect.objectContaining({
          providerId: winningProvider.id,
          config: { effort: null, mode: anthropic ? "enabled" : null, budgetTokens: 32000 },
        }),
      ]);
      expect(transport).not.toHaveBeenCalled();
      release(session);
    }
  );

  test.each(
    (["claude", "claude-auth", "gemini", "gemini-cli"] as const).flatMap((providerType) =>
      [false, true].map((hasThinking) => ({ providerType, hasThinking }))
    )
  )(
    "dispatches $providerType with hasThinking=$hasThinking while audit storage is stalled",
    async ({ providerType, hasThinking }) => {
      vi.useFakeTimers();
      const provider = createProvider(providerType);
      provider.requestTimeoutNonStreamingMs = 20;
      const anthropic = providerType.startsWith("claude");
      const nativeBody = hasThinking
        ? anthropic
          ? { thinking: { type: "enabled", budget_tokens: 8192 } }
          : { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }
        : {};
      const session = createSession(
        providerType === "gemini-cli" ? { request: nativeBody } : nativeBody,
        provider
      );
      const auditWrite = Promise.withResolvers<void>();
      mocks.updateMessageRequestDetails.mockImplementationOnce(() => auditWrite.promise);
      vi.spyOn(internals, "fetchWithoutAutoDecode").mockResolvedValueOnce(okResponse());
      let dispatched: Response | undefined;
      const pending = internals.doForward(session, provider, provider.url).then((response) => {
        dispatched = response;
        return response;
      });

      try {
        await vi.advanceTimersByTimeAsync(1);
        if (!dispatched) throw new Error("Audit storage blocked upstream dispatch");
        expect(await dispatched.text()).toContain('"text":"ok"');
        expect(outgoingSettings(session)[0].config).toEqual(
          !hasThinking
            ? null
            : {
                effort: null,
                mode: anthropic ? "enabled" : null,
                budgetTokens: 8192,
              }
        );
      } finally {
        auditWrite.resolve();
        await vi.advanceTimersByTimeAsync(0);
        const response = await pending;
        if (!response.bodyUsed) await response.body?.cancel();
        release(session);
        vi.useRealTimers();
      }
    }
  );

  test.each(["commit", "fail", "override"] as const)(
    "a pending loser's %s finishes before the selected provider's audit is persisted",
    async (firstWriteOutcome) => {
      vi.useFakeTimers();
      const provider = createProvider("claude", 1);
      provider.firstByteTimeoutStreamingMs = 20;
      if (firstWriteOutcome === "override") {
        provider.anthropicMaxTokensPreference = "64000";
        provider.anthropicThinkingBudgetPreference = "32000";
      }
      const alternative = createProvider("claude", 2);
      alternative.firstByteTimeoutStreamingMs = 20;
      mocks.pickRandomProviderWithExclusion.mockResolvedValueOnce(alternative);
      const session = createSession(
        {
          model: "native-test",
          stream: true,
          thinking: { type: "enabled", budget_tokens: 8192 },
          messages: [{ role: "user", content: "hi" }],
        },
        provider
      );
      let resumeFirstWrite!: () => void;
      const firstWrite = new Promise<void>((resolve) => {
        resumeFirstWrite = resolve;
      });
      let writes = 0;
      let stored: SpecialSetting[] = [];
      mocks.updateMessageRequestDetails.mockImplementation(async (_id, details) => {
        if (++writes === 1) {
          await firstWrite;
          if (firstWriteOutcome === "fail") throw new Error("First audit write failed");
        }
        stored = structuredClone(details.specialSettings as SpecialSetting[]);
      });
      mocks.applyFinal.mockImplementation(async (attempt, outgoing) => {
        if ((attempt as ProxySession).provider?.id === alternative.id) {
          outgoing.thinking = { type: "disabled" };
        }
      });
      vi.spyOn(internals, "fetchWithoutAutoDecode").mockImplementation(async (_url, init) => {
        const wins = JSON.parse(String(init.body)).thinking.type === "disabled";
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (wins) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'
                  )
                );
                controller.close();
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        );
      });
      const outcome = ProxyForwarder.send(session).then(
        (response) => ({ response, error: null }),
        (error: unknown) => ({ response: null, error })
      );

      try {
        await vi.advanceTimersByTimeAsync(25);
        expect(session.provider?.id).toBe(alternative.id);
        resumeFirstWrite();
        await vi.advanceTimersByTimeAsync(0);
        const result = await outcome;
        if (!result.response) throw result.error;
        expect(await result.response.text()).toContain("ok");
        expect(stored.find((setting) => setting.type === "native_thinking_forwarded")).toEqual(
          expect.objectContaining({
            providerId: alternative.id,
            config: { effort: null, mode: "disabled", budgetTokens: null },
          })
        );
        expect(outgoingSettings(session)).toEqual([
          expect.objectContaining({ providerId: alternative.id }),
        ]);
      } finally {
        resumeFirstWrite();
        vi.useRealTimers();
        const result = await outcome;
        if (result.response && !result.response.bodyUsed) await result.response.body?.cancel();
        release(session);
      }
    }
  );

  test("replacement and winner synchronization cannot mutate another attempt's snapshot", () => {
    const provider = createProvider();
    const target = createSession({ model: "native-test" }, provider);
    const config: ThinkingConfigValue = { effort: null, mode: "enabled", budgetTokens: 500 };
    target.recordNativeThinkingForwarded("anthropic", provider.id, config);
    const originalSettings = target.getSpecialSettings();
    const originalSnapshot = outgoingSettings(target)?.[0];
    const winner = internals.createStreamingShadowSession(target, createProvider("claude", 2));
    expect(outgoingSettings(winner)?.[0]).toBe(originalSnapshot);
    config.budgetTokens = 1;
    expect(originalSnapshot?.config?.budgetTokens).toBe(500);

    target.recordNativeThinkingForwarded("anthropic", 1, { ...config, budgetTokens: 32000 });
    winner.recordNativeThinkingForwarded("anthropic", 2, {
      effort: null,
      mode: "enabled",
      budgetTokens: 500,
    });
    const winnerSnapshot = outgoingSettings(winner)?.[0];
    expect(originalSettings).toEqual([originalSnapshot]);
    expect(originalSnapshot?.config?.budgetTokens).toBe(500);
    expect(outgoingSettings(winner)).toHaveLength(1);
    expect(winnerSnapshot).not.toBe(originalSnapshot);

    internals.syncWinningAttemptSession(target, winner);
    expect(outgoingSettings(target)).toEqual([winnerSnapshot]);
    expect(outgoingSettings(target)?.[0]).toBe(winnerSnapshot);
    winner.recordNativeThinkingForwarded("anthropic", 2, null);
    expect(outgoingSettings(target)).toEqual([winnerSnapshot]);
    expect(outgoingSettings(target)?.[0].config?.budgetTokens).toBe(500);
    internals.syncWinningAttemptSession(target, winner);
    expect(outgoingSettings(target)).toEqual([
      expect.objectContaining({ providerId: 2, config: null }),
    ]);
    internals.syncWinningAttemptSession(target, createSession({ model: "native-test" }, provider));
    expect(outgoingSettings(target)).toEqual([]);
  });
});
