import { describe, expect, it, vi } from "vitest";
import { ProxyModelGuard } from "@/app/v1/_lib/proxy/model-guard";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";

vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => "zh-CN"),
}));

function createSession(model: unknown, allowedModels: string[] = [], pathname = "/v1/rerank") {
  return {
    authState: { user: { allowedModels } },
    requestUrl: new URL(pathname, "https://gateway.example.com"),
    getOriginalModel: () => (typeof model === "string" ? model : null),
    request: {
      model: typeof model === "string" ? model : null,
      message: { model },
    },
  } as unknown as ProxySession;
}

describe.each(["/v1/rerank", "/v1/systemone"])("%s model boundary", (endpoint) => {
  const createEndpointSession = (
    model: unknown,
    allowedModels: string[] = [],
    pathname = endpoint
  ) => createSession(model, allowedModels, pathname);
  it.each([undefined, null, "", " \n\t", 123, {}, []])(
    "rejects invalid model %j even without a user allowlist",
    async (model) => {
      const response = await ProxyModelGuard.ensure(createEndpointSession(model));
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({
        error: { type: "invalid_request_error" },
      });
    }
  );

  it("does not accept a Gemini fallback model in place of the required body field", async () => {
    const session = createEndpointSession(undefined);
    session.request.model = "gemini-2.5-flash";
    session.request.message.request = {};
    expect((await ProxyModelGuard.ensure(session))?.status).toBe(400);
  });

  it("applies the model requirement to normalized paths", async () => {
    expect(
      (
        await ProxyModelGuard.ensure(
          createEndpointSession(null, [], `${endpoint.toUpperCase()}/?trace=1`)
        )
      )?.status
    ).toBe(400);
  });

  it("returns the validation error in English regardless of the request locale", async () => {
    const response = await ProxyModelGuard.ensure(createEndpointSession(null));
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { type: "invalid_request_error", message: "model is required" },
    });
  });

  it("enforces the user allowlist for a valid rerank model", async () => {
    expect(
      (await ProxyModelGuard.ensure(createEndpointSession("rerank-model", ["other-model"])))?.status
    ).toBe(400);
    expect(
      await ProxyModelGuard.ensure(createEndpointSession("rerank-model", ["RERANK-MODEL"]))
    ).toBeNull();
    expect(await ProxyModelGuard.ensure(createEndpointSession("rerank-model"))).toBeNull();
  });

  it("preserves optional-model behavior for unrestricted resource endpoints", async () => {
    expect(await ProxyModelGuard.ensure(createSession(null, [], "/v1/models"))).toBeNull();
  });
});
