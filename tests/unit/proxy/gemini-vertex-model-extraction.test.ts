import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import { extractModelFromPath, ProxySession } from "@/app/v1/_lib/proxy/session";
import { detectFormatByEndpoint } from "@/app/v1/_lib/proxy/format-mapper";
import { ProxyModelGuard } from "@/app/v1/_lib/proxy/model-guard";

vi.mock("@/repository/model-price", () => ({ findLatestPriceByModel: vi.fn() }));
vi.mock("@/repository/system-config", () => ({ getSystemSettings: vi.fn() }));

function nativeSession(path: string, message: Record<string, unknown> = {}) {
  const request = new Request(`https://hub.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  return ProxySession.fromContext({
    req: {
      method: request.method,
      url: request.url,
      raw: request,
      header: (name?: string) =>
        name === undefined
          ? Object.fromEntries(request.headers)
          : (request.headers.get(name) ?? undefined),
    },
  } as unknown as Context);
}

describe("native Gemini session path identity", () => {
  it.each([
    "/v1beta/models/gemini%2D2.5%2Dpro:generateContent",
    "/v1beta/models/gemini-2.5-pro:generateContent/",
    "/v1/publishers/google/models/gemini%2D2.5%2Dpro:generateContent/",
    "/v1/projects/p/locations/l/publishers/google/models/gemini-2.5-pro:countTokens/",
  ])("routes and authorizes the actual URL model instead of a fallback for %s", async (path) => {
    const session = await nativeSession(path, { model: "models/gemini-2.5-pro", contents: [] });
    expect(extractModelFromPath(path)).toBe("gemini-2.5-pro");
    expect(session.request.model).toBe("gemini-2.5-pro");
    expect(session.getOriginalModel()).toBe("gemini-2.5-pro");
    expect(session.getRoutingModel()).toBe("gemini-2.5-pro");
    const user = { allowedModels: ["gemini-2.5-flash"] };
    session.authState = {
      user,
    } as unknown as NonNullable<ProxySession["authState"]>;
    expect((await ProxyModelGuard.ensure(session))?.status).toBe(400);
    user.allowedModels = ["gemini-2.5-pro"];
    expect(await ProxyModelGuard.ensure(session)).toBeNull();
    session.beginProviderAttempt();
    expect(session.request.model).toBe("gemini-2.5-pro");
    expect(session.requestUrl.pathname).toBe(path);
  });

  it("uses a path-only trailing-slash model rather than the default fallback model", async () => {
    const session = await nativeSession("/v1beta/models/gemini-2.5-pro:generateContent/", {
      contents: [],
    });
    expect(session.request.model).toBe("gemini-2.5-pro");
    expect(session.getOriginalModel()).toBe("gemini-2.5-pro");
    expect(session.request.message).not.toHaveProperty("model");
  });

  it.each(["gemini%GG", "gemini%2Fpro", "gemini%3Apro", "gemini%20pro"])(
    "rejects malformed or non-segment URL IDs with 400 rather than fallback: %s",
    async (model) => {
      await expect(
        nativeSession(`/v1beta/models/${model}:generateContent/`, { contents: [] })
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  );

  it.each([
    ["batchEmbedContents", { requests: [{ model: "models/gemini-2.5-flash" }] }],
    ["countTokens", { generateContentRequest: { model: "models/gemini-2.5-flash" } }],
  ] as const)("validates nested %s models even with a trailing slash", async (action, message) => {
    await expect(
      nativeSession(`/v1beta/models/gemini-2.5-pro:${action}/`, message)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("keeps percent sequences literal on OpenAI model IDs", async () => {
    const session = await nativeSession("/v1/chat/completions", {
      model: "vendor/gemini%2Dpro",
      messages: [],
    });
    expect(session.request.model).toBe("vendor/gemini%2Dpro");
    expect(session.getOriginalModel()).toBe("vendor/gemini%2Dpro");
  });
});

describe("extractModelFromPath - Vertex AI publishers path", () => {
  it("extracts model from /v1/publishers/google/models/{model}:generateContent", () => {
    expect(
      extractModelFromPath(
        "/v1/publishers/google/models/gemini-3-pro-image-preview:generateContent"
      )
    ).toBe("gemini-3-pro-image-preview");
  });

  it("extracts model from /v1/publishers/google/models/{model}:streamGenerateContent", () => {
    expect(
      extractModelFromPath("/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent")
    ).toBe("gemini-2.5-flash");
  });

  it("extracts model from /v1/publishers/google/models/{model}:countTokens", () => {
    expect(extractModelFromPath("/v1/publishers/google/models/gemini-2.5-pro:countTokens")).toBe(
      "gemini-2.5-pro"
    );
  });

  it("extracts model from path without action suffix", () => {
    expect(extractModelFromPath("/v1/publishers/google/models/gemini-2.5-flash")).toBe(
      "gemini-2.5-flash"
    );
  });

  // regression: existing patterns still work
  it("still extracts model from /v1beta/models/{model}:generateContent", () => {
    expect(extractModelFromPath("/v1beta/models/gemini-2.5-flash:generateContent")).toBe(
      "gemini-2.5-flash"
    );
  });

  it("still extracts model from /v1/models/{model}:generateContent", () => {
    expect(extractModelFromPath("/v1/models/gemini-2.5-pro:generateContent")).toBe(
      "gemini-2.5-pro"
    );
  });

  it("returns null for unrecognized paths", () => {
    expect(extractModelFromPath("/v1/messages")).toBeNull();
    expect(extractModelFromPath("/v1/chat/completions")).toBeNull();
  });
});

describe("detectFormatByEndpoint - Vertex AI publishers path", () => {
  it('returns "gemini" for /v1/publishers/google/models/{model}:generateContent', () => {
    expect(
      detectFormatByEndpoint(
        "/v1/publishers/google/models/gemini-3-pro-image-preview:generateContent"
      )
    ).toBe("gemini");
  });

  it('returns "gemini" for /v1/publishers/google/models/{model}:streamGenerateContent', () => {
    expect(
      detectFormatByEndpoint("/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent")
    ).toBe("gemini");
  });

  it('returns "gemini" for /v1/publishers/google/models/{model}:countTokens', () => {
    expect(detectFormatByEndpoint("/v1/publishers/google/models/gemini-2.5-pro:countTokens")).toBe(
      "gemini"
    );
  });

  // regression: existing patterns still work
  it('still returns "gemini" for /v1beta/models/ path', () => {
    expect(detectFormatByEndpoint("/v1beta/models/gemini-2.5-flash:generateContent")).toBe(
      "gemini"
    );
  });

  it('still returns "gemini-cli" for /v1internal/models/ path', () => {
    expect(detectFormatByEndpoint("/v1internal/models/gemini-2.5-flash:generateContent")).toBe(
      "gemini-cli"
    );
  });

  it("returns null for unknown publishers path actions", () => {
    expect(
      detectFormatByEndpoint("/v1/publishers/google/models/gemini-2.5-flash:unknownAction")
    ).toBeNull();
  });
});
