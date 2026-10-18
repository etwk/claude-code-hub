import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { parseSystemOneMultipartRequest } from "@/app/v1/_lib/proxy/systemone-compat";
import { requestFilterEngine } from "@/lib/request-filter-engine";
import type { Provider } from "@/types/provider";

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: {
    applyFinal: vi.fn(async () => {}),
  },
}));

function createProvider(providerType: "openai-compatible" | "codex"): Provider {
  return {
    id: 1,
    name: `${providerType}-upstream`,
    providerType,
    url:
      providerType === "codex"
        ? "https://codex.example.com/v1"
        : "https://openai.example.com/openai",
    key: "upstream-key",
    preserveClientIp: false,
    priority: 0,
    costMultiplier: 1,
    maxRetryAttempts: 1,
    mcpPassthroughType: "minimax",
    mcpPassthroughUrl: "https://mcp.example.com",
  } as unknown as Provider;
}

function createSession(
  pathname: string,
  providerType: "openai-compatible" | "codex"
): ProxySession {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: "Bearer proxy-user-key",
  });
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "GET",
    requestUrl: new URL(`https://proxy.example.com${pathname}`),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: JSON.stringify(Object.fromEntries(headers.entries())),
    request: {
      model: null,
      log: JSON.stringify({}),
      message: {},
    },
    userAgent: "OpenAITest/1.0",
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: providerType === "codex" ? "response" : "openai",
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    forwardedRequestBody: null,
    endpointPolicy: resolveEndpointPolicy(pathname),
    setCacheTtlResolved: vi.fn(),
    getCacheTtlResolved: vi.fn(() => null),
    getCurrentModel: vi.fn(() => null),
    clientRequestsContext1m: vi.fn(() => false),
    setContext1mApplied: vi.fn(),
    getContext1mApplied: vi.fn(() => false),
    getGroupCostMultiplier: vi.fn(() => 1),
    getEndpointPolicy: vi.fn(() => resolveEndpointPolicy(pathname)),
    isHeaderModified: vi.fn(() => false),
  });

  return session as ProxySession;
}

describe("ProxyForwarder - official OpenAI endpoints stay on provider URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves opaque rerank documents while filtering private top-level parameters", async () => {
    const provider = createProvider("openai-compatible");
    const session = createSession("/v1/rerank?trace=one%2Ftwo", "openai-compatible");
    const documents = [
      "Berlin is in Germany.",
      { text: "Paris is in France.", _id: "doc-1", metadata: { _source: "catalog" } },
    ];
    const body = {
      model: "rerank-example",
      query: "Which city is in France?",
      documents,
      top_n: 1,
      return_documents: true,
      _private: "do not forward",
    };
    session.method = "POST";
    session.request.message = body;
    session.request.model = body.model;
    vi.mocked(requestFilterEngine.applyFinal).mockImplementationOnce(
      async (_session, outgoingBody) => {
        const outgoingDocuments = outgoingBody.documents;
        if (!Array.isArray(outgoingDocuments)) throw new Error("Expected rerank documents");
        const document = outgoingDocuments[1];
        if (!document || typeof document !== "object") throw new Error("Expected object document");
        document.text = "Paris is in France. [filtered]";
      }
    );

    let capturedUrl: string | null = null;
    let capturedBody: BodyInit | null | undefined;
    vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
      async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedBody = init.body;
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
    );
    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(capturedUrl).toBe("https://openai.example.com/openai/v1/rerank?trace=one%2Ftwo");
    expect(JSON.parse(capturedBody as string)).toEqual({
      model: body.model,
      query: body.query,
      documents: [
        "Berlin is in Germany.",
        {
          text: "Paris is in France. [filtered]",
          _id: "doc-1",
          metadata: { _source: "catalog" },
        },
      ],
      top_n: 1,
      return_documents: true,
    });
    expect(body._private).toBe("do not forward");
    expect(documents[1]).toEqual({
      text: "Paris is in France.",
      _id: "doc-1",
      metadata: { _source: "catalog" },
    });
  });

  it("does not route /v1/files through MCP passthrough URL", async () => {
    const provider = createProvider("openai-compatible");
    const session = createSession("/v1/files/file_123/content", "openai-compatible");
    let capturedUrl: string | null = null;

    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (url: string) => {
      capturedUrl = url;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(capturedUrl).toBe("https://openai.example.com/openai/v1/files/file_123/content");
    expect(capturedUrl?.startsWith("https://mcp.example.com")).toBe(false);
  });

  it("does not route /v1/responses/{id} through MCP passthrough URL", async () => {
    const provider = createProvider("codex");
    const session = createSession("/v1/responses/resp_123", "codex");
    let capturedUrl: string | null = null;

    const fetchWithoutAutoDecode = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
    fetchWithoutAutoDecode.mockImplementationOnce(async (url: string) => {
      capturedUrl = url;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(capturedUrl).toBe("https://codex.example.com/v1/responses/resp_123");
    expect(capturedUrl?.startsWith("https://mcp.example.com")).toBe(false);
  });
});

describe.each(["json", "multipart"] as const)(
  "ProxyForwarder - System One %s request isolation",
  (encoding) => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it.each(["client", "filter"] as const)(
      "uses non-streaming timeouts when %s supplies stream true",
      async (streamSource) => {
        vi.useFakeTimers();
        try {
          const provider = createProvider("openai-compatible");
          provider.firstByteTimeoutStreamingMs = 5;
          provider.requestTimeoutNonStreamingMs = 1_000;
          const session = createSession("/V1/SystemOne/?alt=sse", "openai-compatible");
          const body: Record<string, unknown> = {
            model: "jev-latest",
            state: "safe state",
            questions: { decision: { type: "noul", instructions: "Is it safe?" } },
            ...(streamSource === "client" ? { stream: true } : {}),
          };
          session.method = "POST";
          session.request.message = body;
          session.request.model = "jev-latest";
          if (encoding === "multipart") {
            const form = new FormData();
            form.append(
              "request",
              new Blob([JSON.stringify(body)], { type: "application/json" }),
              "request.json"
            );
            form.append("photo", new Blob([new Uint8Array([0x89, 0x50, 0x00, 0xff])]), "photo.png");
            const request = new Request("https://proxy.example.com/v1/systemone", {
              method: "POST",
              body: form,
            });
            const contentType = request.headers.get("content-type")!;
            session.request.buffer = await request.arrayBuffer();
            session.request.systemOneMultipart = parseSystemOneMultipartRequest(
              session.request.buffer,
              contentType
            )!.metadata;
            session.headers.set("content-type", contentType);
          }
          if (streamSource === "filter") {
            vi.mocked(requestFilterEngine.applyFinal).mockImplementationOnce(
              async (_session, outgoingBody) => {
                outgoingBody.stream = true;
              }
            );
          }
          const nativeResult = {
            model: "jev-latest",
            answers: { decision: { type: "noul", noul: 0.98 } },
            usage: { input_tokens: 11, output_tokens: 0 },
          };
          let outgoing: Record<string, unknown> | undefined;
          vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
            async (_url: string, init: RequestInit) => {
              outgoing =
                encoding === "multipart"
                  ? parseSystemOneMultipartRequest(
                      init.body as ArrayBuffer,
                      new Headers(init.headers).get("content-type")!
                    )!.requestMessage
                  : JSON.parse(init.body as string);
              const { promise, resolve, reject } = Promise.withResolvers<Response>();
              const signal = init.signal!;
              const onAbort = () => {
                clearTimeout(timer);
                reject(signal.reason);
              };
              const timer = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve(
                  new Response(JSON.stringify(nativeResult), {
                    headers: { "content-type": "application/json" },
                  })
                );
              }, 25);
              signal.addEventListener("abort", onAbort, { once: true });
              return promise;
            }
          );
          const { doForward } = ProxyForwarder as unknown as {
            doForward: (
              session: ProxySession,
              provider: Provider,
              baseUrl: string
            ) => Promise<Response>;
          };
          const result = doForward(session, provider, provider.url).then(
            async (response) => ({ status: response.status, body: await response.json() }),
            (error) => ({ error })
          );
          await vi.advanceTimersByTimeAsync(50);
          expect(await result).toEqual({ status: 200, body: nativeResult });
          expect(outgoing?.stream).toBe(true);
          expect(body.stream).toBe(streamSource === "client" ? true : undefined);
        } finally {
          vi.useRealTimers();
          vi.restoreAllMocks();
        }
      }
    );

    it("redirects then resets the model without leaking final-filter changes across providers", async () => {
      const providerA = createProvider("openai-compatible");
      providerA.url = "https://api.typesafe.ai/v1";
      providerA.modelRedirects = [
        { matchType: "exact", source: "system-one", target: "system-one-upstream" },
      ];
      const providerB = createProvider("openai-compatible");
      providerB.id = 2;
      providerB.url = "https://other.typesafe.example/v1/systemone";
      providerB.modelRedirects = null;
      const session = createSession("/V1/SystemOne/?trace=one%2Ftwo", "openai-compatible");
      const body = {
        model: "system-one",
        state: [{ _source: "client", details: { _id: "item-1", text: "unmodified" } }],
        questions: {
          _question: {
            type: "choice",
            instructions: "Pick a label",
            criteria: { _option: "original criterion", yes: null },
          },
        },
        assets: {
          _photo: { type: "image", part: "photo", _metadata: { _origin: "upload" } },
        },
        _private: "must not reach the upstream",
      };
      const originalMessage = structuredClone(body);
      const boundary = "systemone-forwarder-boundary";
      const contentType = `multipart/form-data; boundary="${boundary}"`;
      const binary = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xc3, 0x28]),
        Buffer.from(`\r\n--${boundary}--not-a-delimiter\r\n`),
        Buffer.from([0x00, 0xfe]),
      ]);
      const multipartBytes = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="request"; filename="request.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`
        ),
        binary,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const originalBuffer =
        encoding === "multipart"
          ? Uint8Array.from(multipartBytes).buffer
          : new TextEncoder().encode(JSON.stringify(body)).buffer;
      const originalBytes = Uint8Array.from(new Uint8Array(originalBuffer));
      const metadata =
        encoding === "multipart"
          ? Object.freeze({
              ...parseSystemOneMultipartRequest(originalBuffer, contentType)!.metadata,
            })
          : undefined;
      Object.assign(session, { method: "POST" });
      session.request.message = body;
      session.request.model = body.model;
      session.request.buffer = originalBuffer;
      session.request.systemOneMultipart = metadata;
      session.headers.set(
        "content-type",
        encoding === "multipart" ? contentType : "application/json"
      );
      session.headers.set("typesafe-danger-zone-images", "true");
      session.headers.set("x-typesafe-client", "regression-test");
      vi.mocked(session.getCurrentModel).mockImplementation(() => session.request.model);

      let attempt = 0;
      vi.mocked(requestFilterEngine.applyFinal).mockImplementation(
        async (_session, outgoingBody) => {
          attempt += 1;
          const outgoing = outgoingBody as typeof body;
          expect(outgoing).not.toHaveProperty("_private");
          expect(outgoing.state).not.toBe(body.state);
          expect(outgoing.state[0]).toEqual(originalMessage.state[0]);
          expect(outgoing.questions).not.toBe(body.questions);
          expect(outgoing.questions).toEqual(originalMessage.questions);
          expect(outgoing.assets).not.toBe(body.assets);
          expect(outgoing.assets).toEqual(originalMessage.assets);
          outgoing.state[0].details.text = `filtered state ${attempt}`;
          outgoing.questions._question.criteria._option = `filtered criterion ${attempt}`;
          outgoing.assets._photo._metadata._origin = `filtered upload ${attempt}`;
        }
      );

      const captured: Array<{
        url: string;
        body: BodyInit | null | undefined;
        headers: Headers;
      }> = [];
      vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementation(
        async (url: string, init: RequestInit) => {
          captured.push({ url, body: init.body, headers: new Headers(init.headers) });
          return new Response(JSON.stringify({ model: session.request.model, answers: {} }), {
            headers: { "content-type": "application/json" },
          });
        }
      );
      const { doForward } = ProxyForwarder as unknown as {
        doForward: (
          session: ProxySession,
          provider: Provider,
          baseUrl: string
        ) => Promise<Response>;
      };

      for (const [index, provider] of [providerA, providerB].entries()) {
        session.provider = provider;
        const expectedModel = index === 0 ? "system-one-upstream" : "system-one";

        await doForward(session, provider, provider.url);

        expect(session.request.model).toBe(expectedModel);
        expect(session.request.message).toEqual({ ...originalMessage, model: expectedModel });
        expect(session.getOriginalModel()).toBe("system-one");
        expect(session.isModelRedirected()).toBe(index === 0);
        expect(new Uint8Array(originalBuffer)).toEqual(originalBytes);
        const sent = captured[index];
        expect(sent.url).toBe(
          index === 0
            ? "https://api.typesafe.ai/v1/systemone?trace=one%2Ftwo"
            : "https://other.typesafe.example/v1/systemone?trace=one%2Ftwo"
        );
        expect(sent.headers.get("authorization")).toBe("Bearer upstream-key");
        expect(sent.headers.get("typesafe-danger-zone-images")).toBe("true");
        expect(sent.headers.get("x-typesafe-client")).toBe("regression-test");
        let outgoing: Record<string, unknown>;
        if (encoding === "multipart") {
          expect(sent.headers.get("content-type")).toBe(contentType);
          expect(sent.body).toBeInstanceOf(ArrayBuffer);
          const sentBuffer = sent.body as ArrayBuffer;
          expect(sentBuffer).not.toBe(originalBuffer);
          const parsed = parseSystemOneMultipartRequest(sentBuffer, contentType)!;
          outgoing = parsed.requestMessage;
          expect(Buffer.from(sentBuffer).includes(binary)).toBe(true);
          expect(Buffer.from(sentBuffer).subarray(0, metadata!.requestPartBodyStart)).toEqual(
            Buffer.from(originalBuffer).subarray(0, metadata!.requestPartBodyStart)
          );
          expect(Buffer.from(sentBuffer).subarray(parsed.metadata.requestPartBodyEnd)).toEqual(
            Buffer.from(originalBuffer).subarray(metadata!.requestPartBodyEnd)
          );
          expect(session.request.buffer).toBe(originalBuffer);
          expect(session.request.systemOneMultipart).toBe(metadata);
          expect(metadata).toEqual(
            parseSystemOneMultipartRequest(originalBuffer, contentType)?.metadata
          );
        } else {
          expect(sent.headers.get("content-type")).toBe("application/json");
          expect(typeof sent.body).toBe("string");
          outgoing = JSON.parse(sent.body as string);
          expect(JSON.parse(new TextDecoder().decode(session.request.buffer))).toEqual({
            ...originalMessage,
            model: expectedModel,
          });
        }
        expect(outgoing).toEqual({
          model: expectedModel,
          state: [
            {
              _source: "client",
              details: { _id: "item-1", text: `filtered state ${index + 1}` },
            },
          ],
          questions: {
            _question: {
              type: "choice",
              instructions: "Pick a label",
              criteria: { _option: `filtered criterion ${index + 1}`, yes: null },
            },
          },
          assets: {
            _photo: {
              type: "image",
              part: "photo",
              _metadata: { _origin: `filtered upload ${index + 1}` },
            },
          },
        });
      }
      expect(captured).toHaveLength(2);
      expect(requestFilterEngine.applyFinal).toHaveBeenCalledTimes(2);
    });
  }
);
