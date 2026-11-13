import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isHttp2Enabled: vi.fn(async () => false),
  getCachedSystemSettings: vi.fn(async () => ({
    enableClaudeMetadataUserIdInjection: false,
    enableBillingHeaderRectifier: false,
  })),
  getProxyAgentForProvider: vi.fn(async () => null),
  getGlobalAgentPool: vi.fn(() => ({
    getAgent: vi.fn(),
    markOriginUnhealthy: vi.fn(),
  })),
  evaluateResponsesWsEligibility: vi.fn(async () => ({
    isWebsocketClient: false,
    eligible: false,
  })),
  tryResponsesWebsocketUpstream: vi.fn(),
  applyFinalRequestFilters: vi.fn(async () => undefined),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    isHttp2Enabled: mocks.isHttp2Enabled,
    getCachedSystemSettings: mocks.getCachedSystemSettings,
  };
});

vi.mock("@/lib/proxy-agent", () => ({
  getProxyAgentForProvider: mocks.getProxyAgentForProvider,
  getGlobalAgentPool: mocks.getGlobalAgentPool,
}));

vi.mock("@/app/v1/_lib/responses-ws/eligibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/v1/_lib/responses-ws/eligibility")>();
  return {
    ...actual,
    evaluateResponsesWsEligibility: mocks.evaluateResponsesWsEligibility,
    getResponsesWsSessionId: vi.fn(() => "client-ws-session"),
  };
});

vi.mock("@/app/v1/_lib/responses-ws/upstream-adapter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/v1/_lib/responses-ws/upstream-adapter")>();
  return {
    ...actual,
    tryResponsesWebsocketUpstream: mocks.tryResponsesWebsocketUpstream,
  };
});

vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: {
    applyForProvider: vi.fn(async () => {}),
    applyFinal: mocks.applyFinalRequestFilters,
  },
}));

import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { rectifyResponseInput } from "@/app/v1/_lib/proxy/response-input-rectifier";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";
import {
  clearResponsesWsUnsupportedCache,
  isResponsesWsUnsupported,
} from "@/app/v1/_lib/responses-ws/unsupported-cache";

function createProvider(): Provider {
  return {
    id: 1,
    name: "codex-upstream",
    providerType: "codex",
    url: "https://upstream.example.com/v1/responses",
    key: "upstream-key",
    preserveClientIp: false,
    priority: 0,
    maxRetryAttempts: 1,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
  } as unknown as Provider;
}

function createRawPassthroughSession(bodyText: string, extraHeaders?: HeadersInit): ProxySession {
  const headers = new Headers({
    "content-type": "application/json",
    "content-length": String(new TextEncoder().encode(bodyText).byteLength),
    ...Object.fromEntries(new Headers(extraHeaders).entries()),
  });
  const originalHeaders = new Headers(headers);
  const specialSettings: unknown[] = [];
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://proxy.example.com/v1/responses/compact?stream=false"),
    headers,
    originalHeaders,
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: "gpt-5.5",
      log: bodyText,
      message: JSON.parse(bodyText) as Record<string, unknown>,
      buffer: new TextEncoder().encode(bodyText).buffer,
    },
    userAgent: "CodexTest/1.0",
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: "openai",
    providerType: null,
    originalModelName: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    forwardedRequestBody: null,
    endpointPolicy: resolveEndpointPolicy("/v1/responses/compact"),
    setCacheTtlResolved: vi.fn(),
    getCacheTtlResolved: vi.fn(() => null),
    clientRequestsContext1m: vi.fn(() => false),
    setContext1mApplied: vi.fn(),
    getContext1mApplied: vi.fn(() => false),
    getGroupCostMultiplier: vi.fn(() => 1),
    getEndpointPolicy: vi.fn(() => resolveEndpointPolicy("/v1/responses/compact")),
    addSpecialSetting: vi.fn((setting: unknown) => {
      specialSettings.push(setting);
    }),
    getSpecialSettings: vi.fn(() => specialSettings),
    isHeaderModified: vi.fn((key: string) => originalHeaders.get(key) !== headers.get(key)),
  });

  return session as ProxySession;
}

function readBodyText(body: BodyInit | undefined): string | null {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  throw new Error(`Unsupported body type: ${Object.prototype.toString.call(body)}`);
}

describe("ProxyForwarder raw passthrough regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearResponsesWsUnsupportedCache();
    mocks.evaluateResponsesWsEligibility.mockResolvedValue({
      isWebsocketClient: false,
      eligible: false,
    });
    mocks.tryResponsesWebsocketUpstream.mockReset();
  });

  it("raw passthrough 应优先保留原始请求体字节，而不是重新 JSON.stringify", async () => {
    const originalBody = '{\n  "model": "gpt-5.5",\n  "input": [1, 2, 3]\n}\n';
    const session = createRawPassthroughSession(originalBody);
    const provider = createProvider();

    let capturedInit: { body?: BodyInit; headers?: HeadersInit } | null = null;
    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as any, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedInit = { body: init.body ?? undefined, headers: init.headers ?? undefined };
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2" },
      });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(readBodyText(capturedInit?.body)).toBe(originalBody);
  });

  it.each([
    {
      path: "/v1/messages/count_tokens",
      managedPath: "/v1/messages/count_tokens",
      providerType: "claude" as const,
      model: "claude-opus-latest",
      target: "claude-opus-4-7",
      input: [{ role: "user", content: "count these tokens" }],
    },
    {
      path: "/v1/responses/compact",
      managedPath: "/v1/responses/compact",
      providerType: "codex" as const,
      model: "gpt-latest",
      target: "gpt-5.5",
      input: [{ type: "compaction", encrypted_content: "opaque+/=state" }],
    },
    {
      path: "/v1/responses",
      managedPath: "/v1/responses/compact",
      providerType: "codex" as const,
      model: "gpt-latest",
      target: "gpt-5.5",
      input: [{ type: "compaction_trigger" }],
    },
  ])("routes aliases on raw $path without changing other payload fields", async (scenario) => {
    const originalBody = {
      model: scenario.model,
      ...(scenario.providerType === "claude"
        ? { messages: scenario.input }
        : { input: scenario.input }),
      _opaque_client_field: { model: "not-a-routing-field" },
      stream: false,
      temperature: 0.75,
    };
    const session = createRawPassthroughSession(JSON.stringify(originalBody), {
      "content-encoding": "identity",
    });
    session.request.model = scenario.model;
    session.requestUrl = new URL(`https://proxy.example.com${scenario.path}?transport=http`);
    const endpointPolicy = resolveEndpointPolicy(scenario.managedPath);
    Object.assign(session, {
      endpointPolicy,
      getEndpointPolicy: () => endpointPolicy,
      originalFormat: scenario.providerType === "claude" ? "claude" : "openai",
    });
    const provider = createProvider();
    provider.providerType = scenario.providerType;
    provider.url = "https://upstream.example.com";
    provider.modelRedirects = [
      { matchType: "exact", source: scenario.model, target: scenario.target },
    ];

    // Narrow test boundary: exercise real request preparation, replacing only HTTP transport.
    const forwarder = ProxyForwarder as unknown as {
      fetchWithoutAutoDecode: (url: string, init: RequestInit) => Promise<Response>;
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };
    let forwarded: { url: string; body: BodyInit | undefined; headers: Headers } | undefined;
    vi.spyOn(forwarder, "fetchWithoutAutoDecode").mockImplementationOnce(async (url, init) => {
      forwarded = { url, body: init.body ?? undefined, headers: new Headers(init.headers) };
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    await forwarder.doForward(session, provider, provider.url);

    expect(new URL(forwarded!.url).pathname).toBe(scenario.path);
    expect(new URL(forwarded!.url).searchParams.get("transport")).toBe("http");
    expect(JSON.parse(readBodyText(forwarded!.body)!)).toEqual({
      ...originalBody,
      model: scenario.target,
    });
    expect(session.getOriginalModel()).toBe(scenario.model);
    expect(session.getCurrentModel()).toBe(scenario.target);
    expect(forwarded!.headers.get("content-encoding")).toBeNull();
    expect(forwarded!.headers.get("content-length")).toBeNull();
  });

  it.each([
    {
      body: String.raw`{
  "model" : "alias",
  "tools": [{"name":"f","input_schema":{"properties":{"id":{"const":9007199254740993},"ratio":{"const":1.234567890123456789}}}}],
  "messages": [{"role":"user","content":"你好 { \"model\": \"alias\" } \\"}],
  "nested": {"model":"alias"}
}
`,
      target: "concrete",
      replacements: ['"alias"'],
    },
    {
      body: String.raw`{"\u006dodel":"shadow-alias", "model":"alias", "nested":{"model":"alias","id":9007199254740993}}`,
      target: 'concrete/"quoted"\\model',
      replacements: ['"shadow-alias"', '"alias"'],
    },
    {
      body: String.raw`{"model":{"model":"untouched-until-value-replaced","values":[null,true,[1,2]]}, "\u006d\u006fdel" : "alias", "schema":{"enum":[9007199254740993]}}`,
      target: "concrete",
      replacements: [
        '{"model":"untouched-until-value-replaced","values":[null,true,[1,2]]}',
        '"alias"',
      ],
    },
  ])("preserves non-model bytes when routing raw JSON: $target", async (scenario) => {
    const session = createRawPassthroughSession(scenario.body);
    session.request.model = "alias";
    const provider = createProvider();
    provider.modelRedirects = [{ matchType: "exact", source: "alias", target: scenario.target }];
    const forwarder = ProxyForwarder as unknown as {
      fetchWithoutAutoDecode: (url: string, init: RequestInit) => Promise<Response>;
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };
    let forwardedBody: BodyInit | undefined;
    vi.spyOn(forwarder, "fetchWithoutAutoDecode").mockImplementationOnce(async (_url, init) => {
      forwardedBody = init.body ?? undefined;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    await forwarder.doForward(session, provider, provider.url);

    let expected = scenario.body;
    for (const value of scenario.replacements) {
      expected = expected.replace(value, JSON.stringify(scenario.target));
    }
    expect(readBodyText(forwardedBody)).toBe(expected);
    expect(JSON.parse(readBodyText(forwardedBody)!).model).toBe(scenario.target);
    expect(session.getOriginalModel()).toBe("alias");
    expect(session.getCurrentModel()).toBe(scenario.target);
  });

  it.each(["another-model", "gpt-5.5"])(
    "preserves raw bytes and encoding for unchanged redirect %s",
    async (source) => {
      const originalBody = '{\n "model": "gpt-5.5", "input": [], "_opaque": 9007199254740993\n}\n';
      const session = createRawPassthroughSession(originalBody, { "content-encoding": "snappy" });
      const provider = createProvider();
      provider.modelRedirects = [{ matchType: "exact", source, target: "gpt-5.5" }];
      const forwarder = ProxyForwarder as unknown as {
        fetchWithoutAutoDecode: (url: string, init: RequestInit) => Promise<Response>;
        doForward: (
          session: ProxySession,
          provider: Provider,
          baseUrl: string
        ) => Promise<Response>;
      };
      let forwardedBody: BodyInit | undefined;
      let forwardedHeaders: Headers | undefined;
      vi.spyOn(forwarder, "fetchWithoutAutoDecode").mockImplementationOnce(async (_url, init) => {
        forwardedBody = init.body ?? undefined;
        forwardedHeaders = new Headers(init.headers);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      });

      await forwarder.doForward(session, provider, provider.url);

      expect(readBodyText(forwardedBody)).toBe(originalBody);
      expect(forwardedHeaders!.get("content-encoding")).toBe("snappy");
    }
  );

  it("非 raw 请求重新序列化后移除失真的 content-encoding 与 content-length", async () => {
    const originalBody = '{\n  "model": "gpt-5.5",\n  "input": [1, 2, 3]\n}\n';
    const session = createRawPassthroughSession(originalBody, {
      "content-encoding": "snappy",
    });
    const endpointPolicy = resolveEndpointPolicy("/v1/responses");
    Object.assign(session, {
      requestUrl: new URL("https://proxy.example.com/v1/responses"),
      endpointPolicy,
      getEndpointPolicy: vi.fn(() => endpointPolicy),
    });
    const provider = createProvider();

    let capturedBody: BodyInit | undefined;
    let capturedHeaders: Headers | null = null;
    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as any, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedBody = init.body ?? undefined;
      capturedHeaders = new Headers(init.headers);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2" },
      });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(readBodyText(capturedBody)).toBe(JSON.stringify(JSON.parse(originalBody)));
    expect(capturedHeaders?.get("content-encoding")).toBeNull();
    expect(capturedHeaders?.get("content-length")).toBeNull();
  });

  it("raw passthrough 保留无法解码的 content-encoding 与原始请求体字节", async () => {
    const originalBody = '{\n  "model": "gpt-5.5",\n  "input": [1, 2, 3]\n}\n';
    const session = createRawPassthroughSession(originalBody, {
      "content-encoding": "snappy",
    });
    const provider = createProvider();

    let capturedBody: BodyInit | undefined;
    let capturedHeaders: Headers | null = null;
    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as any, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedBody = init.body ?? undefined;
      capturedHeaders = new Headers(init.headers);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2" },
      });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(readBodyText(capturedBody)).toBe(originalBody);
    expect(capturedHeaders?.get("content-encoding")).toBe("snappy");
  });

  it("remote compaction v2 保留 /v1/responses wire path 与原始请求体", async () => {
    const originalBody =
      '{\n  "model": "gpt-5.5",\n  "stream": true,\n  "input": [{"type":"compaction_trigger"}]\n}\n';
    const upstreamSse =
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","encrypted_content":"opaque-state"}}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_compact","status":"completed","output":[{"type":"compaction","encrypted_content":"opaque-state"}]}}\n\n';
    const session = createRawPassthroughSession(originalBody, {
      "x-codex-beta-features": "remote_compaction_v2",
    });
    session.requestUrl = new URL("https://proxy.example.com/v1/responses?transport=http");
    const provider = createProvider();

    let capturedUrl: string | null = null;
    let capturedBody: BodyInit | undefined;
    let capturedHeaders: Headers | null = null;
    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as any, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body ?? undefined;
      capturedHeaders = new Headers(init.headers);
      return new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    const response = await doForward(session, provider, provider.url);

    expect(new URL(capturedUrl as string).pathname).toBe("/v1/responses");
    expect(new URL(capturedUrl as string).searchParams.get("transport")).toBe("http");
    expect(readBodyText(capturedBody)).toBe(originalBody);
    expect(capturedHeaders?.get("x-codex-beta-features")).toBe("remote_compaction_v2");
    expect(await response.text()).toBe(upstreamSse);
  });

  it("remote compaction v2 ArrayBuffer 请求体仍通过上游 Responses WebSocket", async () => {
    const requestBody = {
      model: "gpt-5.5",
      stream: true,
      previous_response_id: "resp_previous",
      input: [{ type: "compaction_trigger" }],
    };
    const originalBody = JSON.stringify(requestBody);
    const upstreamSse =
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_compact","status":"completed"}}\n\n';
    const session = createRawPassthroughSession(originalBody, {
      "x-codex-beta-features": "remote_compaction_v2",
    });
    session.requestUrl = new URL("https://proxy.example.com/v1/responses");
    const provider = createProvider();

    mocks.evaluateResponsesWsEligibility.mockResolvedValue({
      isWebsocketClient: true,
      eligible: true,
      endpointId: null,
    });
    mocks.tryResponsesWebsocketUpstream.mockResolvedValue({
      response: new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      connected: true,
      reused: true,
    });

    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as any, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(
      async () => new Response("unexpected HTTP fallback", { status: 500 })
    );
    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    const response = await doForward(session, provider, provider.url);

    expect(mocks.tryResponsesWebsocketUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        body: requestBody,
        sessionId: "client-ws-session",
      })
    );
    expect(fetchWithoutAutoDecode).not.toHaveBeenCalled();
    expect(await response.text()).toBe(upstreamSse);
  });

  it("retries a WS size rejection over HTTP without caching the endpoint as unsupported", async () => {
    const provider = createProvider();
    const body = JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true });
    const makeSession = () => {
      const session = createRawPassthroughSession(body);
      const endpointPolicy = resolveEndpointPolicy("/v1/responses");
      Object.assign(session, {
        requestUrl: new URL("https://proxy.example.com/v1/responses"),
        endpointPolicy,
        getEndpointPolicy: vi.fn(() => endpointPolicy),
      });
      return session;
    };
    const session = makeSession();
    mocks.evaluateResponsesWsEligibility.mockResolvedValue({
      isWebsocketClient: true,
      eligible: true,
    });
    mocks.tryResponsesWebsocketUpstream.mockResolvedValueOnce({
      failed: true,
      reason: "ws_payload_too_large",
      message: "Payload too large",
      cacheableAsUnsupported: false,
    });
    const sse = 'data: {"type":"response.completed","response":{"id":"http"}}\n\n';
    const fetchWithoutAutoDecode = vi
      .spyOn(ProxyForwarder as any, "fetchWithoutAutoDecode")
      .mockResolvedValueOnce(
        new Response(sse, { headers: { "content-type": "text/event-stream" } })
      );
    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    expect(await (await doForward(session, provider, provider.url)).text()).toBe(sse);
    expect(fetchWithoutAutoDecode).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithoutAutoDecode.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(provider.url);
    expect(JSON.parse(readBodyText(init.body ?? undefined)!)).toEqual(JSON.parse(body));
    expect(isResponsesWsUnsupported(provider.id, null).unsupported).toBe(false);
    expect(session.providerChain).toEqual([
      expect.objectContaining({ reason: "responses_ws_fallback", id: provider.id }),
    ]);

    mocks.tryResponsesWebsocketUpstream.mockResolvedValueOnce({
      response: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      connected: true,
    });
    expect(await (await doForward(makeSession(), provider, provider.url)).text()).toBe(sse);
    expect(mocks.tryResponsesWebsocketUpstream).toHaveBeenCalledTimes(2);
    expect(fetchWithoutAutoDecode).toHaveBeenCalledTimes(1);
  });

  it("remote compaction v2 将单对象 input 规范化后再透传", async () => {
    const originalBody = '{"model":"gpt-5.5","stream":true,"input":{"type":"compaction_trigger"}}';
    const session = createRawPassthroughSession(originalBody, {
      "x-codex-beta-features": "remote_compaction_v2",
    });
    session.requestUrl = new URL("https://proxy.example.com/v1/responses?transport=http");
    const provider = createProvider();

    const result = rectifyResponseInput(session.request.message);
    expect(result.applied).toBe(true);
    await session.syncRequestBodyFromMessage();

    let capturedUrl: string | null = null;
    let capturedBody: BodyInit | undefined;
    let capturedHeaders: Headers | null = null;
    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as any, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body ?? undefined;
      capturedHeaders = new Headers(init.headers);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2" },
      });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(new URL(capturedUrl as string).pathname).toBe("/v1/responses");
    expect(new URL(capturedUrl as string).searchParams.get("transport")).toBe("http");
    expect(JSON.parse(readBodyText(capturedBody) ?? "{}").input).toEqual([
      { type: "compaction_trigger" },
    ]);
    expect(capturedHeaders?.get("content-length")).toBeNull();
    expect(capturedHeaders?.get("x-codex-beta-features")).toBe("remote_compaction_v2");
  });

  it("raw passthrough 出站请求不得继续携带 transfer-encoding 这类 hop-by-hop 头", async () => {
    const body = '{"model":"gpt-5.5","input":[]}';
    const session = createRawPassthroughSession(body, {
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    });
    const provider = createProvider();

    let capturedHeaders: Headers | null = null;
    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as any, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2" },
      });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(capturedHeaders?.get("connection")).toBeNull();
    expect(capturedHeaders?.get("transfer-encoding")).toBeNull();
  });
});
