import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/drizzle/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
  },
}));

vi.mock("@/drizzle/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/drizzle/schema")>();
  return {
    ...actual,
    messageRequest: {},
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@/lib/sensitive-word-detector", () => ({
  sensitiveWordDetector: {
    isEmpty: vi.fn(() => false),
    detect: vi.fn((text: string) =>
      text.includes("blocked")
        ? {
            matched: true,
            word: "blocked",
            matchType: "contains",
            matchedText: "blocked",
          }
        : { matched: false }
    ),
  },
}));

import { ProxySensitiveWordGuard } from "@/app/v1/_lib/proxy/sensitive-word-guard";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { sensitiveWordDetector } from "@/lib/sensitive-word-detector";

function createContext(request: Request) {
  return {
    req: {
      method: request.method,
      url: request.url,
      raw: request,
      header(name?: string) {
        if (name) {
          return request.headers.get(name) ?? undefined;
        }
        return Object.fromEntries(request.headers.entries());
      },
    },
  } as any;
}

async function createJsonSession(message: Record<string, unknown>, pathname = "/v1/rerank") {
  const request = new Request(`https://proxy.example.com${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  return ProxySession.fromContext(createContext(request));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProxySensitiveWordGuard - multipart image logical body", () => {
  it("inspects multipart image prompt text via the logical body view", async () => {
    const formData = new FormData();
    formData.append("model", "gpt-image-1.5");
    formData.append("prompt", "this is blocked content");
    formData.append(
      "image[]",
      new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" }),
      "image.png"
    );

    const request = new Request("https://proxy.example.com/v1/images/edits", {
      method: "POST",
      body: formData,
    });
    const session = await ProxySession.fromContext(createContext(request));
    session.authState = {
      success: true,
      user: { id: 1, name: "tester" } as any,
      key: { id: 2 } as any,
      apiKey: "sk-test",
    };

    const response = await ProxySensitiveWordGuard.ensure(session);

    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain("敏感词");
  });

  it("inspects repeated multipart prompt fields via the logical body array view", async () => {
    const formData = new FormData();
    formData.append("model", "gpt-image-1.5");
    formData.append("prompt", "safe content");
    formData.append("prompt", "blocked content");
    formData.append(
      "image[]",
      new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" }),
      "image.png"
    );

    const request = new Request("https://proxy.example.com/v1/images/edits", {
      method: "POST",
      body: formData,
    });
    const session = await ProxySession.fromContext(createContext(request));
    session.authState = {
      success: true,
      user: { id: 1, name: "tester" } as any,
      key: { id: 2 } as any,
      apiKey: "sk-test",
    };

    const response = await ProxySensitiveWordGuard.ensure(session);

    expect(response?.status).toBe(400);
  });
});

describe("ProxySensitiveWordGuard - rerank text", () => {
  it.each(["/v1/rerank", "/V1/RERANK/?trace=1"])(
    "blocks sensitive query text on %s",
    async (pathname) => {
      const session = await createJsonSession(
        { model: "rerank-model", query: "blocked query", documents: ["safe document"] },
        pathname
      );

      const response = await ProxySensitiveWordGuard.ensure(session);

      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({
        error: { message: expect.stringContaining('敏感词："blocked"') },
      });
    }
  );

  it.each([
    "blocked document",
    { text: "blocked document" },
    { content: "blocked document" },
    { text: "safe text", content: "blocked document" },
  ])("blocks sensitive document text in %j", async (document) => {
    const session = await createJsonSession({
      model: "rerank-model",
      query: "safe query",
      documents: ["safe document", document],
    });

    const response = await ProxySensitiveWordGuard.ensure(session);

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { message: expect.stringContaining('敏感词："blocked"') },
    });
  });

  it("ignores opaque fields and leaves rerank document objects unchanged", async () => {
    const message = {
      model: "rerank-model",
      query: "safe query",
      documents: [
        "safe document",
        {
          text: "safe text",
          content: "safe content",
          id: "blocked-id",
          _text: "blocked private text",
          metadata: { text: "blocked metadata" },
          payload: { content: "blocked nested content" },
        },
        { id: "blocked opaque document", text: { value: "blocked nested text" } },
        ["blocked non-text document"],
        null,
        123,
      ],
      metadata: { query: "blocked metadata query" },
      _query: "blocked private query",
    };
    const session = await createJsonSession(message);
    const documentObjects = session.request.message.documents;

    const response = await ProxySensitiveWordGuard.ensure(session);

    expect(response).toBeNull();
    expect(vi.mocked(sensitiveWordDetector.detect).mock.calls.map(([text]) => text)).toEqual([
      "safe query",
      "safe document",
      "safe text",
      "safe content",
    ]);
    expect(session.request.message).toEqual(message);
    expect(session.request.message.documents).toBe(documentObjects);
  });

  it.each(["/v1/messages", "/v1/chat/completions", "/v1/responses"])(
    "does not interpret query or documents as text on %s",
    async (pathname) => {
      const session = await createJsonSession(
        {
          model: "chat-model",
          query: "blocked query metadata",
          documents: ["blocked document metadata", { text: "blocked text metadata" }],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "safe message" },
                { type: "image_url", image_url: { url: "https://example.com/blocked.png" } },
              ],
            },
          ],
        },
        pathname
      );

      expect(await ProxySensitiveWordGuard.ensure(session)).toBeNull();
      expect(vi.mocked(sensitiveWordDetector.detect).mock.calls.map(([text]) => text)).toEqual([
        "safe message",
      ]);
    }
  );

  it.each([
    {
      pathname: "/v1/messages",
      message: {
        messages: [{ role: "user", content: [{ type: "text", text: "blocked message" }] }],
      },
    },
    {
      pathname: "/v1/chat/completions",
      message: { messages: [{ role: "user", content: "blocked message" }] },
    },
    {
      pathname: "/v1/responses",
      message: {
        input: [{ role: "user", content: [{ type: "input_text", text: "blocked message" }] }],
      },
    },
  ])("preserves existing text blocking on $pathname", async ({ pathname, message }) => {
    const session = await createJsonSession({ model: "chat-model", ...message }, pathname);

    expect((await ProxySensitiveWordGuard.ensure(session))?.status).toBe(400);
  });
});

describe("ProxySensitiveWordGuard - System One inference text", () => {
  it.each(["/v1/systemone", "/V1/SystemOne/", "/v1/systemone?trace=1"])(
    "blocks nested state on normalized endpoint %s",
    async (pathname) => {
      const session = await createJsonSession(
        {
          model: "jev-1.13.0",
          state: { history: ["safe context", { _application: { text: "blocked state" } }] },
          questions: {},
        },
        pathname
      );
      const original = structuredClone(session.request.message);
      const state = session.request.message.state;

      const response = await ProxySensitiveWordGuard.ensure(session);

      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({
        error: { type: "invalid_request_error" },
      });
      expect(session.request.message).toEqual(original);
      expect(session.request.message.state).toBe(state);
    }
  );

  it.each([
    "blocked string state",
    ["safe state", "blocked array state"],
    { history: { nested: [{ content: "blocked object state" }] } },
    { _text: "blocked underscore application text" },
  ])(
    "inspects all logical state string shapes without dropping underscore keys: %j",
    async (state) => {
      const session = await createJsonSession(
        { model: "jev-1.13.0", state, questions: {} },
        "/v1/systemone"
      );

      expect((await ProxySensitiveWordGuard.ensure(session))?.status).toBe(400);
    }
  );

  it.each([
    { type: "noul", instructions: "blocked instructions" },
    {
      type: "choice",
      instructions: { steps: ["safe", { _detail: "blocked nested instructions" }] },
    },
    { type: "score", criteria: "blocked criteria" },
    { type: "choice", criteria: { ordinary: "blocked choice description" } },
    { type: "choice", criteria: { "blocked null-description label": null } },
    { type: "choice", criteria: { _blocked_application_label: null } },
    { type: "noul", criteria: { true: "blocked positive description", false: "safe negative" } },
    { type: "noul", criteria: { true: "safe positive", false: "blocked negative description" } },
    { type: "score", criteria: ["safe score", "blocked score description"] },
    { type: "score", criteria: [{ score: 0, description: "blocked score array object" }] },
    { type: "choice", criteria: { option: { _detail: ["blocked nested choice description"] } } },
  ])("blocks instructions, criteria, and choice option labels: %j", async (question) => {
    const message = { model: "jev-1.13.0", state: "safe state", questions: { decision: question } };
    const session = await createJsonSession(message, "/v1/systemone");
    const questions = session.request.message.questions;

    const response = await ProxySensitiveWordGuard.ensure(session);

    expect(response?.status).toBe(400);
    expect(session.request.message).toEqual(message);
    expect(session.request.message.questions).toBe(questions);
  });

  it.each([
    { state: { "blocked state field": null } },
    { state: { records: [{ _blocked_field: false }] } },
    {
      questions: {
        decision: { type: "noul", instructions: { "blocked instruction field": null } },
      },
    },
    {
      questions: {
        decision: { type: "choice", criteria: { ordinary: { "blocked criterion field": null } } },
      },
    },
    { state: { "blocked-photo": null }, assets: { "blocked-photo": { part: "image" } } },
    {
      questions: { decision: { type: "noul", instructions: { "blocked-photo": null } } },
      assets: { "blocked-photo": { part: "image" } },
    },
  ])("blocks semantic object keys as literal text: %j", async (content) => {
    const message = { model: "jev-latest", state: "safe", questions: {}, ...content };
    const session = await createJsonSession(message, "/v1/systemone");

    expect((await ProxySensitiveWordGuard.ensure(session))?.status).toBe(400);
    expect(session.request.message).toEqual(message);
  });

  it("ignores asset payloads, metadata, model, and question IDs while preserving the original body", async () => {
    const message = {
      model: "blocked-model-name",
      state: {
        applicationField: "safe state value",
        _application: ["safe underscore text", 4, false, null, ""],
      },
      questions: {
        "blocked-question-id": {
          type: "choice",
          instructions: "safe choice instructions",
          criteria: { ordinary: null, "": null, _application: "safe choice description" },
          metadata: { instructions: "blocked question metadata" },
          _private: "blocked question private metadata",
        },
        boolean: {
          type: "noul",
          instructions: "safe noul instructions",
          criteria: { true: "safe positive description", false: "safe negative description" },
        },
        score: { type: "score", criteria: ["safe low score", "safe high score", null, 1] },
        "blocked-empty-question": null,
        "blocked-array-question": ["blocked unsupported question"],
        "blocked-string-question": "blocked unsupported question",
      },
      assets: {
        "blocked-asset-reference": {
          type: "image",
          data: "data:image/png;base64,blocked-base64-payload",
          part: "blocked-image-part",
          text: "blocked asset text",
        },
      },
      metadata: { state: "blocked top-level metadata", questions: "blocked metadata questions" },
      _private: { text: "blocked private metadata" },
    };
    const original = structuredClone(message);
    const session = await createJsonSession(message, "/v1/systemone");
    const logicalMessage = session.request.message;
    const { state, questions, assets } = logicalMessage;

    const response = await ProxySensitiveWordGuard.ensure(session);

    expect(response).toBeNull();
    expect(message).toEqual(original);
    expect(session.request.message).toEqual(original);
    expect(session.request.message).toBe(logicalMessage);
    expect(session.request.message.state).toBe(state);
    expect(session.request.message.questions).toBe(questions);
    expect(session.request.message.assets).toBe(assets);
  });

  it("does not reinterpret opaque top-level chat-shaped fields as System One inference text", async () => {
    const message = {
      model: "jev-1.13.0",
      state: "safe inference state",
      questions: {},
      prompt: ["blocked opaque prompt"],
      system: "blocked opaque system",
      messages: [{ role: "user", content: "blocked opaque chat message" }],
      input: [{ role: "user", content: [{ type: "input_text", text: "blocked opaque input" }] }],
    };
    const session = await createJsonSession(message, "/v1/systemone");

    expect(await ProxySensitiveWordGuard.ensure(session)).toBeNull();
    expect(vi.mocked(sensitiveWordDetector.detect).mock.calls.map(([text]) => text)).toEqual([
      "safe inference state",
    ]);
    expect(session.request.message).toEqual(message);
  });

  it("uses noul description values rather than treating criteria keys as choice labels", async () => {
    const session = await createJsonSession(
      {
        model: "jev-1.13.0",
        state: "safe state",
        questions: {
          decision: {
            type: "noul",
            criteria: { true: "safe positive", false: "safe negative", "blocked opaque key": null },
          },
        },
      },
      "/v1/systemone"
    );

    expect(await ProxySensitiveWordGuard.ensure(session)).toBeNull();
    expect(vi.mocked(sensitiveWordDetector.detect).mock.calls.map(([text]) => text)).toEqual([
      "safe state",
      "safe positive",
      "safe negative",
    ]);
  });

  it.each([
    { state: "blocked-photo", questions: {} },
    { state: "Compare blocked-photo and blocked-photo.", questions: {} },
    { state: "bloimagecked", questions: {} },
    {
      state: "safe",
      questions: { decision: { type: "noul", instructions: "See blocked-photo." } },
    },
    {
      state: "safe",
      questions: { decision: { type: "choice", criteria: { ordinary: "blocked-photo" } } },
    },
    { state: "safe", questions: { decision: { type: "score", criteria: ["blocked-photo"] } } },
  ])("does not scan image references or join text across images: %j", async (content) => {
    const message = {
      model: "jev-latest",
      ...content,
      assets: { "blocked-photo": { part: "photo" }, image: { part: "second-photo" } },
    };
    const session = await createJsonSession(message, "/v1/systemone");
    const original = structuredClone(session.request.message);

    expect(await ProxySensitiveWordGuard.ensure(session)).toBeNull();
    expect(session.request.message).toEqual(original);
  });

  it.each([
    { state: "blocked real text next to image" },
    { state: "image blocked real text" },
    { state: "blocked-PHOTO" },
    {
      state: "blocked-photo",
      questions: { decision: { type: "choice", criteria: { "blocked-photo": null } } },
    },
  ])(
    "still blocks surrounding text, case mismatches, and literal choice names: %j",
    async (content) => {
      const session = await createJsonSession(
        {
          model: "jev-latest",
          questions: {},
          ...content,
          assets: { "blocked-photo": { part: "photo" }, image: { part: "second-photo" } },
        },
        "/v1/systemone"
      );

      expect((await ProxySensitiveWordGuard.ensure(session))?.status).toBe(400);
    }
  );

  it("matches literal references with punctuation and prefers complete overlapping references", async () => {
    const session = await createJsonSession(
      {
        model: "jev-latest",
        state: ["photo-blocked", "photo-blocked next to [blocked].*"],
        questions: {},
        assets: {
          photo: { part: "short" },
          "photo-blocked": { part: "long" },
          "[blocked].*": { part: "punctuation" },
        },
      },
      "/v1/systemone"
    );

    expect(await ProxySensitiveWordGuard.ensure(session)).toBeNull();
  });

  it.each([64, 65])("bounds recursive state extraction at depth 64 (depth %s)", async (depth) => {
    let state: unknown = "blocked deep state";
    for (let level = 0; level < depth; level++) {
      state = { nested: state };
    }
    const session = await createJsonSession(
      { model: "jev-1.13.0", state, questions: {} },
      "/v1/systemone"
    );

    const response = await ProxySensitiveWordGuard.ensure(session);

    if (depth === 64) {
      expect(response?.status).toBe(400);
    } else {
      expect(response).toBeNull();
    }
  });

  it.each([
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/rerank",
    "/v1/systemone/extra",
    "/v1/systemone-archive",
  ])("does not inspect System One state or questions on other endpoints: %s", async (pathname) => {
    const session = await createJsonSession(
      {
        model: "other-model",
        state: { _application: ["blocked state metadata"] },
        questions: {
          decision: {
            type: "choice",
            instructions: "blocked instructions metadata",
            criteria: { "blocked option metadata": "blocked criteria metadata" },
          },
        },
        messages: [{ role: "user", content: "safe ordinary message" }],
      },
      pathname
    );

    expect(await ProxySensitiveWordGuard.ensure(session)).toBeNull();
    expect(vi.mocked(sensitiveWordDetector.detect).mock.calls.map(([text]) => text)).toEqual([
      "safe ordinary message",
    ]);
  });
});

describe("ProxySensitiveWordGuard - System One multipart logical body", () => {
  it.each(["blocked logical state", "safe logical state"])(
    "inspects JSON state but never binary image bytes: %s",
    async (state) => {
      const message = {
        model: "jev-1.13.0",
        state: { context: state },
        questions: {},
        assets: { photo: { type: "image", part: "photo" } },
      };
      const formData = new FormData();
      formData.append("request", new Blob([JSON.stringify(message)], { type: "application/json" }));
      formData.append(
        "photo",
        new File([new Uint8Array([0, 255, 128, 0]), "blocked binary image bytes"], "image.png", {
          type: "image/png",
        })
      );
      const request = new Request("https://proxy.example.com/V1/SystemOne/?trace=1", {
        method: "POST",
        body: formData,
      });
      const originalBuffer = await request.clone().arrayBuffer();
      const session = await ProxySession.fromContext(createContext(request));
      const { buffer, systemOneMultipart, message: logicalMessage } = session.request;
      const original = structuredClone(logicalMessage);

      const response = await ProxySensitiveWordGuard.ensure(session);

      if (state.includes("blocked")) {
        expect(response?.status).toBe(400);
      } else {
        expect(response).toBeNull();
      }
      expect(session.request.message).toEqual(message);
      expect(session.request.message).toEqual(original);
      expect(session.request.message).toBe(logicalMessage);
      expect(systemOneMultipart).toMatchObject({
        contentType: request.headers.get("content-type"),
        requestPartBodyStart: expect.any(Number),
        requestPartBodyEnd: expect.any(Number),
      });
      expect(session.request.systemOneMultipart).toBe(systemOneMultipart);
      expect(session.request.buffer).toBe(buffer);
      expect(new Uint8Array(session.request.buffer!)).toEqual(new Uint8Array(originalBuffer));
      expect(session.request.log).toContain(state);
      expect(session.request.log).not.toContain("blocked binary image bytes");
      expect(session.request.log).not.toContain("multipart/form-data");
    }
  );
});
