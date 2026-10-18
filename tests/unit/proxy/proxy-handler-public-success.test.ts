import { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { FakeStreamingWhitelistEntry } from "@/types/system-config";

type ProxySettingsFixture = {
  readonly enableHighConcurrencyMode: boolean;
  readonly allowNonConversationEndpointProviderFallback: boolean;
  readonly enableResponseFixer: boolean;
  readonly enableResponseInputRectifier: boolean;
  readonly fakeStreamingWhitelist: FakeStreamingWhitelistEntry[];
};

const boundary = vi.hoisted(() => ({
  decrementConcurrentCount: vi.fn<(sessionId: string) => Promise<void>>(),
  incrementConcurrentCount: vi.fn<(sessionId: string) => Promise<void>>(),
  loadSettings: vi.fn<() => Promise<ProxySettingsFixture>>(),
  runGuards: vi.fn<(session: ProxySession) => Promise<Response | null>>(),
  send: vi.fn<(session: ProxySession) => Promise<Response>>(),
  fakeStreamingCalls: 0,
}));

let observedSession: ProxySession | null = null;

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getCachedSystemSettings: boundary.loadSettings,
}));

vi.mock("@/lib/config/system-settings-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/system-settings-cache")>()),
  getCachedSystemSettings: boundary.loadSettings,
}));

vi.mock("@/app/v1/_lib/proxy/guard-pipeline", () => ({
  GuardPipelineBuilder: {
    fromSession: () => ({ run: boundary.runGuards }),
  },
}));

vi.mock("@/app/v1/_lib/proxy/forwarder", () => ({
  ProxyForwarder: { send: boundary.send },
}));

vi.mock("@/app/v1/_lib/proxy/fake-streaming/proxy-integration", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/v1/_lib/proxy/fake-streaming/proxy-integration")>();

  return {
    ...actual,
    tryFakeStreamingPath: async (
      ...args: Parameters<typeof actual.tryFakeStreamingPath>
    ): Promise<Response | null> => {
      boundary.fakeStreamingCalls += 1;
      return await actual.tryFakeStreamingPath(...args);
    },
  };
});

vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: {
    decrementConcurrentCount: boundary.decrementConcurrentCount,
    incrementConcurrentCount: boundary.incrementConcurrentCount,
    refreshSession: vi.fn(),
  },
}));

vi.mock("@/lib/proxy-status-tracker", () => ({
  ProxyStatusTracker: {
    getInstance: () => ({ endRequest: vi.fn(), startRequest: vi.fn() }),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));

import { handleProxyRequest } from "@/app/v1/_lib/proxy-handler";

const defaultSettings: ProxySettingsFixture = {
  enableHighConcurrencyMode: false,
  allowNonConversationEndpointProviderFallback: true,
  enableResponseFixer: true,
  enableResponseInputRectifier: true,
  fakeStreamingWhitelist: [],
};

function createContext(pathname: string, body: Record<string, unknown>): Context {
  const request = new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Context(request);
}

describe("handleProxyRequest public success behavior", () => {
  beforeEach(() => {
    observedSession = null;
    boundary.fakeStreamingCalls = 0;
    boundary.runGuards.mockReset();
    boundary.send.mockReset();
    boundary.incrementConcurrentCount.mockReset();
    boundary.decrementConcurrentCount.mockReset();
    boundary.loadSettings.mockReset();
    boundary.loadSettings.mockResolvedValue(defaultSettings);
    boundary.runGuards.mockImplementation(async (session) => {
      observedSession = session;
      return null;
    });
    boundary.incrementConcurrentCount.mockResolvedValue(undefined);
    boundary.decrementConcurrentCount.mockResolvedValue(undefined);
  });

  it("returns a successful upstream response through the real dispatcher", async () => {
    boundary.send.mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_1", type: "message", content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const response = await handleProxyRequest(
      createContext("/v1/messages", { model: "claude-test", messages: [] })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ id: "msg_1", type: "message", content: [] });
    expect(boundary.send).toHaveBeenCalledOnce();
  });

  it("returns synthesized SSE when the request is fake-stream eligible", async () => {
    boundary.loadSettings.mockResolvedValue({
      ...defaultSettings,
      fakeStreamingWhitelist: [{ model: "gpt-image-2", groupTags: [] }],
    });
    boundary.send.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "generated" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const response = await handleProxyRequest(
      createContext("/v1/messages", { model: "gpt-image-2", messages: [], stream: true })
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: message_start");
    expect(body).toContain('"text":"generated"');
    expect(body).toContain("event: message_stop");
    expect(boundary.send).toHaveBeenCalledOnce();
    expect(boundary.fakeStreamingCalls).toBe(1);
    expect(observedSession?.request.message.stream).toBe(false);
  });

  it.each([true, false])("keeps Chat fake streaming for stream=%s", async (stream) => {
    boundary.loadSettings.mockResolvedValue({
      ...defaultSettings,
      fakeStreamingWhitelist: [{ model: "chat-model", groupTags: [] }],
    });
    const completion = {
      id: "chatcmpl_fake",
      object: "chat.completion",
      model: "chat-model",
      choices: [
        { index: 0, message: { role: "assistant", content: "generated" }, finish_reason: "stop" },
      ],
    };
    boundary.send.mockResolvedValue(
      new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const response = await handleProxyRequest(
      createContext("/v1/chat/completions", { model: "chat-model", messages: [], stream })
    );

    expect(response.status).toBe(200);
    expect(observedSession?.request.message.stream).toBe(false);
    expect(boundary.send).toHaveBeenCalledOnce();
    expect(boundary.fakeStreamingCalls).toBe(1);
    if (stream) {
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const body = await response.text();
      expect(body).toContain('"object":"chat.completion.chunk"');
      expect(body).toContain('"content":"generated"');
      expect(body).toContain("data: [DONE]");
    } else {
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual(completion);
    }
  });

  it.each(["/v1/rerank", "/v1/rerank/", "/v1/ReRaNk", "/V1/ReRaNk/"])(
    "bypasses fake streaming for a whitelisted reranker on %s",
    async (pathname) => {
      boundary.loadSettings.mockResolvedValue({
        ...defaultSettings,
        fakeStreamingWhitelist: [{ model: "reranker", groupTags: [] }],
      });
      const request = { model: "reranker", query: "hello", documents: ["hello world"] };
      const result = {
        id: "rerank_1",
        model: "reranker",
        results: [{ index: 0, relevance_score: 0.98 }],
      };
      boundary.send.mockResolvedValue(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json", "x-upstream-rerank": "preserved" },
        })
      );

      const response = await handleProxyRequest(createContext(pathname, request));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("x-upstream-rerank")).toBe("preserved");
      expect(await response.json()).toEqual(result);
      expect(observedSession?.originalFormat).toBe("openai");
      expect(observedSession?.request.message).toEqual(request);
      expect(observedSession?.request.message).not.toHaveProperty("stream");
      expect(boundary.send).toHaveBeenCalledOnce();
      expect(boundary.fakeStreamingCalls).toBe(1);
    }
  );

  it.each(["/v1/systemone", "/V1/SystemOne/"])(
    "keeps whitelisted System One models on the JSON path at %s",
    async (pathname) => {
      boundary.loadSettings.mockResolvedValue({
        ...defaultSettings,
        fakeStreamingWhitelist: [{ model: "jev-latest", groupTags: [] }],
      });
      const request = {
        model: "jev-latest",
        state: "A refund request",
        questions: { billing: { type: "noul", instructions: "Is this billing?" } },
      };
      const result = {
        model: "jev-1.13.0",
        answers: { billing: { type: "noul", noul: 0.98 } },
        usage: { input_tokens: 20, output_tokens: 2 },
      };
      boundary.send.mockResolvedValue(
        new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "x-typesafe-request-id": "req-1" },
        })
      );

      const response = await handleProxyRequest(createContext(pathname, request));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("x-typesafe-request-id")).toBe("req-1");
      expect(await response.json()).toEqual(result);
      expect(observedSession?.request.message).not.toHaveProperty("stream");
      expect(boundary.send).toHaveBeenCalledOnce();
    }
  );

  it("normalizes Responses input and output at the public boundary", async () => {
    boundary.send.mockImplementation(
      async (session) =>
        new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            echoed_input: session.request.message.input,
            output: [{ type: "message", content: null }],
            tools: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );

    const response = await handleProxyRequest(
      createContext("/v1/responses", { model: "gpt-5", input: "hello" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "resp_1",
      object: "response",
      echoed_input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      output: [{ type: "message", content: [] }],
      tools: [],
    });
  });

  it("routes remote compaction v2 through the v1 compact management policy", async () => {
    boundary.send.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: "compaction", encrypted_content: "opaque-state" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const response = await handleProxyRequest(
      createContext("/v1/responses", {
        model: "gpt-5-codex",
        input: [{ role: "user", content: "keep" }, { type: "compaction_trigger" }],
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      output: [{ type: "compaction", encrypted_content: "opaque-state" }],
    });
    expect(observedSession?.getEndpoint()).toBe("/v1/responses");
    expect(observedSession?.getManagedEndpoint()).toBe("/v1/responses/compact");
    expect(observedSession?.getEndpointPolicy().kind).toBe("raw_passthrough");
    expect(boundary.fakeStreamingCalls).toBe(0);
  });

  it("normalizes object-form remote compaction before raw passthrough", async () => {
    boundary.loadSettings.mockResolvedValue({
      ...defaultSettings,
      fakeStreamingWhitelist: [{ model: "gpt-5-codex", groupTags: [] }],
    });
    boundary.send.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: "compaction", encrypted_content: "opaque-state" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const response = await handleProxyRequest(
      createContext("/v1/responses", {
        model: "gpt-5-codex",
        stream: true,
        input: { type: "compaction_trigger" },
      })
    );

    expect(response.status).toBe(200);
    expect(observedSession?.getManagedEndpoint()).toBe("/v1/responses/compact");
    expect(observedSession?.getEndpointPolicy().kind).toBe("raw_passthrough");
    expect(observedSession?.request.message.input).toEqual([{ type: "compaction_trigger" }]);
    expect(JSON.parse(new TextDecoder().decode(observedSession?.request.buffer)).input).toEqual([
      { type: "compaction_trigger" },
    ]);
    expect(boundary.fakeStreamingCalls).toBe(0);
    expect(boundary.send).toHaveBeenCalledOnce();
  });
});
