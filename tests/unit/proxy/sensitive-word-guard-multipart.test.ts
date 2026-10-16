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
