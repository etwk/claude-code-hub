import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxyModelGuard } from "@/app/v1/_lib/proxy/model-guard";
import { ProxyProviderRequestFilter } from "@/app/v1/_lib/proxy/provider-request-filter";
import { ProxyRequestFilter } from "@/app/v1/_lib/proxy/request-filter";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { rectifyThinkingBudget } from "@/app/v1/_lib/proxy/thinking-budget-rectifier";
import { rectifyAnthropicRequestMessage } from "@/app/v1/_lib/proxy/thinking-signature-rectifier";
import { requestFilterEngine } from "@/lib/request-filter-engine";
import type { RequestFilter } from "@/repository/request-filters";
import type { Provider } from "@/types/provider";

vi.mock("@/repository/model-price", () => ({ findLatestPriceByModel: vi.fn() }));
vi.mock("@/repository/system-config", () => ({ getSystemSettings: vi.fn() }));

function context(request: Request): Context {
  return {
    req: {
      method: request.method,
      url: request.url,
      raw: request,
      header: (name?: string) =>
        name === undefined
          ? Object.fromEntries(request.headers)
          : (request.headers.get(name) ?? undefined),
    },
  } as unknown as Context;
}

async function jsonSession(message: Record<string, unknown>, path = "/v1/messages") {
  return ProxySession.fromContext(
    context(
      new Request(`https://hub.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-baseline": "global" },
        body: JSON.stringify(message),
      })
    )
  );
}

function modelFilter(replacement: unknown, overrides: Partial<RequestFilter> = {}): RequestFilter {
  return {
    id: 1,
    name: "model",
    description: null,
    scope: "body",
    action: "json_path",
    matchType: null,
    target: "model",
    replacement,
    priority: 0,
    isEnabled: true,
    bindingType: "global",
    providerIds: null,
    groupTags: null,
    ruleMode: "simple",
    executionPhase: "guard",
    operations: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

afterEach(() => requestFilterEngine.setFiltersForTest([]));

describe("session model identity boundaries", () => {
  it("preserves client authorization and original billing across global/provider/final rewrites", async () => {
    const session = await jsonSession({ model: "client-A", messages: [] });
    // Narrow authorization fixture: the model guard reads only user.allowedModels.
    const authorization = {
      user: { allowedModels: ["client-A"] },
      success: true,
      key: null,
      apiKey: null,
    } as unknown as NonNullable<ProxySession["authState"]>;
    session.authState = authorization;
    expect(await ProxyModelGuard.ensure(session)).toBeNull();

    requestFilterEngine.setFiltersForTest([modelFilter("routing-B")]);
    await ProxyRequestFilter.ensure(session);
    expect(session.getOriginalModel()).toBe("client-A");
    expect(session.getRoutingModel()).toBe("routing-B");
    expect(session.request.model).toBe("routing-B");
    expect(await ProxyModelGuard.ensure(session)).toBeNull();

    const originalBuffer = session.request.buffer;
    session.beginProviderAttempt();
    session.provider = { id: 1 } as Provider;
    requestFilterEngine.setFiltersForTest([
      modelFilter("provider-C", {
        bindingType: "providers",
        providerIds: [1],
      }),
    ]);
    await ProxyProviderRequestFilter.ensure(session);
    expect(session.request.model).toBe("provider-C");

    const outgoing = { ...session.request.message };
    requestFilterEngine.setFiltersForTest([modelFilter("final-D", { executionPhase: "final" })]);
    await requestFilterEngine.applyFinal(session, outgoing, new Headers());
    session.synchronizeRequestModel(outgoing);
    expect(session.getCurrentModel()).toBe("final-D");
    expect(session.getOriginalModel()).toBe("client-A");
    expect(session.getRoutingModel()).toBe("routing-B");

    session.request.buffer = new TextEncoder().encode("previous provider body").buffer;
    session.headers.set("x-attempt", "previous-provider");
    session.request.message.extra = { contaminated: true };
    session.beginProviderAttempt();
    expect(session.request.message).toEqual({ model: "routing-B", messages: [] });
    expect(session.request.model).toBe("routing-B");
    expect(session.request.buffer).toBe(originalBuffer);
    expect(session.headers.has("x-attempt")).toBe(false);
    expect(session.headers.get("x-baseline")).toBe("global");
  });

  it("captures a null routing identity once rather than treating it as uncaptured", async () => {
    const session = await jsonSession({});
    expect(session.getRoutingModel()).toBeNull();
    session.captureRoutingModel();
    session.request.model = "provider-only";
    session.captureRoutingModel();
    expect(session.getRoutingModel()).toBeNull();
    session.beginProviderAttempt();
    expect(session.request.model).toBeNull();
    expect(session.getOriginalModel()).toBeNull();
  });

  it.each([null, 42, "", "   ", ["other"]])(
    "rejects an invalid global model edit: %j",
    async (model) => {
      const session = await jsonSession({ model: "client-A" });
      requestFilterEngine.setFiltersForTest([modelFilter(model)]);
      await expect(ProxyRequestFilter.ensure(session)).rejects.toMatchObject({ statusCode: 400 });
      expect(session.getOriginalModel()).toBe("client-A");
    }
  );

  it("does not swallow invalid provider edits under fail-open filtering", async () => {
    const session = await jsonSession({ model: "client-A" });
    session.beginProviderAttempt();
    session.provider = { id: 1 } as Provider;
    requestFilterEngine.setFiltersForTest([
      modelFilter(null, {
        bindingType: "providers",
        providerIds: [1],
      }),
    ]);
    await expect(ProxyProviderRequestFilter.ensure(session)).rejects.toMatchObject({
      statusCode: 400,
    });
    session.beginProviderAttempt();
    expect(session.request.model).toBe("client-A");
    expect(session.request.message.model).toBe("client-A");
  });

  it("replays serial retry fixes without retaining provider edits or mutating hedge registries", async () => {
    const originalMessage = {
      model: "client-A",
      max_tokens: 512,
      thinking: { type: "enabled", budget_tokens: 5 },
      messages: [{ role: "user", content: [{ type: "text", text: "hello", signature: "stale" }] }],
    };
    const session = await jsonSession(originalMessage);
    session.beginProviderAttempt();
    session.request.message.model = "provider-C";
    session.request.message.providerOnly = "must not survive";
    session.synchronizeRequestModel();
    expect(rectifyThinkingBudget(session.request.message).applied).toBe(true);
    session.registerProviderRetryRectifier(1, rectifyThinkingBudget);

    // Match production's shallow session copy, with independent mutable request objects.
    const shadow = Object.assign(Object.create(ProxySession.prototype), session, {
      request: { ...session.request },
      headers: new Headers(session.headers),
      requestUrl: new URL(session.requestUrl),
    }) as ProxySession;
    expect(rectifyAnthropicRequestMessage(session.request.message).applied).toBe(true);
    session.registerProviderRetryRectifier(1, rectifyAnthropicRequestMessage);

    session.beginProviderAttempt();
    session.applyProviderRetryRectifiers(1);
    expect(session.request.message).toEqual({
      ...originalMessage,
      max_tokens: 64000,
      thinking: { type: "enabled", budget_tokens: 32000 },
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(session.getRoutingModel()).toBe("client-A");

    shadow.beginProviderAttempt();
    shadow.applyProviderRetryRectifiers(1);
    expect(shadow.request.message).toEqual({
      ...originalMessage,
      max_tokens: 64000,
      thinking: { type: "enabled", budget_tokens: 32000 },
    });

    session.beginProviderAttempt();
    session.applyProviderRetryRectifiers(2);
    expect(session.request.message).toEqual(originalMessage);
  });

  it("rejects removal rather than billing a model absent from the outgoing body", async () => {
    const session = await jsonSession({ model: "client-A" });
    delete session.request.message.model;
    expect(() => session.synchronizeRequestModel()).toThrow("must not remove the model");
  });

  it("normalizes resource model names only for native Gemini paths", async () => {
    const gemini = await jsonSession(
      { model: "models/gemini-2.5-flash", contents: [] },
      "/v1beta/models/gemini-2.5-flash:generateContent"
    );
    expect(gemini.getOriginalModel()).toBe("gemini-2.5-flash");
    // Narrow authorization fixture: the model guard reads only user.allowedModels.
    const authorization = {
      user: { allowedModels: ["gemini-2.5-flash"] },
      success: true,
      key: null,
      apiKey: null,
    } as unknown as NonNullable<ProxySession["authState"]>;
    gemini.authState = authorization;
    expect(await ProxyModelGuard.ensure(gemini)).toBeNull();
    const openai = await jsonSession({ model: "models/custom-model" }, "/v1/chat/completions");
    expect(openai.request.model).toBe("models/custom-model");
  });

  it.each(["vendor%2FModel", "ft%3Agpt-4o-mini%3Aorg%3Acustom%3Aid"])(
    "keeps the opaque OpenAI metadata routing identity %s without a GET body",
    async (id) => {
      const session = await ProxySession.fromContext(
        context(new Request(`https://hub.test/v1/models/${id}/`))
      );
      await ProxyRequestFilter.ensure(session);
      session.beginProviderAttempt();
      expect(session.getOriginalModel()).toBe(id);
      expect(session.getRoutingModel()).toBe(id);
      expect(session.getCurrentModel()).toBe(id);
      expect(session.requestUrl.pathname).toBe(`/v1/models/${id}/`);
      expect(session.request.message).toEqual({});
    }
  );
  it("matches a percent-encoded native URL model against decoded body identities", async () => {
    const session = await jsonSession(
      { model: "models/gemini-2.5-flash", contents: [] },
      "/v1beta/models/gemini%2D2.5%2Dflash:generateContent/"
    );
    expect(session.getOriginalModel()).toBe("gemini-2.5-flash");
    await ProxyRequestFilter.ensure(session);
    expect(session.getRoutingModel()).toBe("gemini-2.5-flash");
  });

  it.each(["gemini%ZZ", "gemini%2Fother", "gemini%3Aother", "gemini%20other"])(
    "rejects malformed native URL identity %s rather than substituting a default",
    async (model) => {
      await expect(
        jsonSession({ contents: [] }, `/v1beta/models/${model}:generateContent`)
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  );

  it.each([
    {
      path: "/v1beta/models/gemini-A:batchEmbedContents/",
      body: { requests: [{ model: "models/gemini-B" }] },
    },
    {
      path: "/v1beta/models/gemini-A:countTokens/",
      body: { generateContentRequest: { model: "models/gemini-B" } },
    },
  ])(
    "validates nested native identities on catalog trailing-slash routes: $path",
    async ({ path, body }) => {
      await expect(jsonSession(body, path)).rejects.toMatchObject({ statusCode: 400 });
    }
  );

  it.each([
    { model: "models/gemini-B" },
    { requests: [{ model: "models/gemini-B", content: {} }] },
  ])("rejects native input fields that disagree with the URL target", async (body) => {
    await expect(
      jsonSession(body, "/v1beta/models/gemini-A:batchEmbedContents")
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("drops retained routing snapshots when request memory is forcibly released", async () => {
    const session = await jsonSession({ model: "client-A", messages: [{ content: "large body" }] });
    session.captureRoutingBaseline();
    session.registerProviderRetryRectifier(1, rectifyThinkingBudget);
    session.dropRequestBodyAfterForcedMemoryRelease();
    expect(session.request.buffer).toBeUndefined();
    expect(session.request.message).toEqual({});
    expect(Reflect.get(session, "routingBaseline")).toBeUndefined();
    expect(Reflect.get(session, "providerRetryRectifiers")).toBeUndefined();
  });

  it("updates native nested model/path identities and resets them before the next provider", async () => {
    const session = await jsonSession(
      { requests: [{ model: "models/gemini-A", content: {} }] },
      "/v1beta/models/gemini-A:batchEmbedContents"
    );
    session.captureRoutingBaseline();
    session.beginProviderAttempt();
    const requests = session.request.message.requests;
    if (!Array.isArray(requests)) throw new Error("Expected native batch requests");
    requests[0].model = "models/gemini-B";
    session.synchronizeRequestModel();
    expect(session.request.model).toBe("gemini-B");
    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini-B:batchEmbedContents");
    expect(Object.hasOwn(session.request.message, "model")).toBe(false);
    session.beginProviderAttempt();
    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini-A:batchEmbedContents");
    expect(session.request.message.requests).toEqual([{ model: "models/gemini-A", content: {} }]);
  });
});

describe("audio multipart session parsing", () => {
  it.each(["transcriptions", "translations"])(
    "keeps %s binary bytes separate from the logical text view",
    async (endpoint) => {
      const form = new FormData();
      form.set("model", "whisper-1");
      form.set("prompt", "transcribe this");
      form.set(
        "file",
        new File([new Uint8Array([0, 255, 128, 10, 13])], "audio.wav", { type: "audio/wav" })
      );
      const request = new Request(`https://hub.test/v1/audio/${endpoint}`, {
        method: "POST",
        body: form,
      });
      const original = await request.clone().arrayBuffer();
      const session = await ProxySession.fromContext(context(request));
      expect(session.request.message).toEqual({ model: "whisper-1", prompt: "transcribe this" });
      expect(session.request.model).toBe("whisper-1");
      expect(session.request.audioMultipart).toBeDefined();
      expect(new Uint8Array(session.request.buffer!)).toEqual(new Uint8Array(original));
      expect(session.request.log).not.toContain("audio.wav");
      expect(session.request.log).not.toContain("Content-Disposition");
      const metadata = session.request.audioMultipart;
      const buffer = session.request.buffer;
      session.captureRoutingBaseline();
      session.request.message.model = "other";
      session.beginProviderAttempt();
      expect(session.request.audioMultipart).toBe(metadata);
      expect(session.request.buffer).toBe(buffer);
      expect(session.request.message.model).toBe("whisper-1");
    }
  );

  it("releases decoded large audio text metadata with the source body on forced memory drop", async () => {
    const prompt = "large-transcription-context ".repeat(8192);
    const form = new FormData();
    form.set("model", "whisper-1");
    form.set("prompt", prompt);
    form.set("file", new File([new Uint8Array(1024)], "audio.wav", { type: "audio/wav" }));
    const session = await ProxySession.fromContext(
      context(
        new Request("https://hub.test/v1/audio/transcriptions", { method: "POST", body: form })
      )
    );
    const metadata = session.request.audioMultipart;
    expect(metadata?.parts.find((part) => part.name === "prompt")?.text).toBe(prompt);
    expect(session.request.message.prompt).toBe(prompt);
    expect(session.request.buffer?.byteLength).toBeGreaterThan(prompt.length);
    session.beginProviderAttempt();

    session.dropRequestBodyAfterForcedMemoryRelease();

    expect(session.request.audioMultipart).toBeUndefined();
    expect(session.request.buffer).toBeUndefined();
    expect(session.request.message).toEqual({});
    expect(session.request.log).toBe("");
    expect(session.forwardedRequestBody).toBeNull();
    // Owners release their reference; immutable metadata shared by attempts is never mutated.
    expect(metadata?.parts.find((part) => part.name === "prompt")?.text).toBe(prompt);
  });

  it.each(["missing", "duplicate", "file"])(
    "rejects %s multipart model fields explicitly",
    async (kind) => {
      const form = new FormData();
      form.set("file", new File(["sound"], "audio.wav"));
      if (kind === "duplicate") {
        form.append("model", "one");
        form.append("model", "two");
      }
      if (kind === "file") form.set("model", new File(["one"], "model.txt"));
      const request = new Request("https://hub.test/v1/audio/transcriptions", {
        method: "POST",
        body: form,
      });
      await expect(ProxySession.fromContext(context(request))).rejects.toMatchObject({
        statusCode: 400,
      });
    }
  );
});
