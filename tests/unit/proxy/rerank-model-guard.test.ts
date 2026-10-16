import { createTranslator } from "next-intl";
import { getLocale } from "next-intl/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyModelGuard } from "@/app/v1/_lib/proxy/model-guard";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import enErrors from "../../../messages/en/errors.json";
import zhErrors from "../../../messages/zh-CN/errors.json";

vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => "en"),
  getTranslations: vi.fn(async ({ locale }: { locale: string }) =>
    createTranslator({
      locale,
      messages: { errors: locale === "zh-CN" ? zhErrors : enErrors },
      namespace: "errors",
    })
  ),
}));

beforeEach(() => {
  vi.mocked(getLocale).mockResolvedValue("en");
});

function createSession(model: unknown, allowedModels: string[] = [], pathname = "/v1/rerank") {
  return {
    authState: { user: { allowedModels } },
    requestUrl: new URL(pathname, "https://gateway.example.com"),
    request: {
      model: typeof model === "string" ? model : null,
      message: { model },
    },
  } as unknown as ProxySession;
}

describe("rerank model boundary", () => {
  it.each([undefined, null, "", " \n\t", 123, {}, []])(
    "rejects invalid model %j even without a user allowlist",
    async (model) => {
      const response = await ProxyModelGuard.ensure(createSession(model));
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({
        error: { type: "invalid_request_error" },
      });
    }
  );

  it("does not accept a Gemini fallback model in place of the required body field", async () => {
    const session = createSession(undefined);
    session.request.model = "gemini-2.5-flash";
    session.request.message.request = {};
    expect((await ProxyModelGuard.ensure(session))?.status).toBe(400);
  });

  it("applies the same model requirement to normalized rerank paths", async () => {
    expect(
      (await ProxyModelGuard.ensure(createSession(null, [], "/V1/RERANK/?trace=1")))?.status
    ).toBe(400);
  });

  it("returns the validation error in the request locale", async () => {
    const english = await ProxyModelGuard.ensure(createSession(null));
    const englishError = (await english?.json()).error;
    vi.mocked(getLocale).mockResolvedValue("zh-CN");
    const chinese = await ProxyModelGuard.ensure(createSession(null));
    const chineseError = (await chinese?.json()).error;

    expect(chinese?.status).toBe(400);
    expect(chineseError.type).toBe(englishError.type);
    expect(chineseError.message).toContain("model");
    expect(chineseError.message).toMatch(/\p{Script=Han}/u);
    expect(englishError.message).not.toMatch(/\p{Script=Han}/u);
  });

  it("enforces the user allowlist for a valid rerank model", async () => {
    expect(
      (await ProxyModelGuard.ensure(createSession("rerank-model", ["other-model"])))?.status
    ).toBe(400);
    expect(
      await ProxyModelGuard.ensure(createSession("rerank-model", ["RERANK-MODEL"]))
    ).toBeNull();
    expect(await ProxyModelGuard.ensure(createSession("rerank-model"))).toBeNull();
  });

  it("preserves optional-model behavior for unrestricted resource endpoints", async () => {
    expect(await ProxyModelGuard.ensure(createSession(null, [], "/v1/models"))).toBeNull();
  });
});
