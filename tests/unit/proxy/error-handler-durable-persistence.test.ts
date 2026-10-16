import { Context } from "hono";
import { DrizzleQueryError } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { getLocale } from "next-intl/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ProxyErrorHandler } from "@/app/v1/_lib/proxy/error-handler";
import { ProxyError } from "@/app/v1/_lib/proxy/errors";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { DbPoolAdmissionError } from "@/drizzle/admitted-client";
import type { Locale } from "@/i18n/config";
import type { ErrorDetectionResult } from "@/lib/error-rule-detector";
import type { emitProxyLangfuseTrace } from "@/lib/langfuse/emit-proxy-trace";
import type { updateMessageRequestDetailsDurably } from "@/repository/message";
import type { Key } from "@/types/key";
import type { User } from "@/types/user";
import enErrors from "../../../messages/en/errors.json";
import jaErrors from "../../../messages/ja/errors.json";
import ruErrors from "../../../messages/ru/errors.json";
import zhCnErrors from "../../../messages/zh-CN/errors.json";
import zhTwErrors from "../../../messages/zh-TW/errors.json";

const mocks = vi.hoisted(() => ({
  detectAsync: vi.fn<(content: string) => Promise<ErrorDetectionResult>>(),
  emitProxyLangfuseTrace: vi.fn<typeof emitProxyLangfuseTrace>(),
  endRequest: vi.fn(),
  getCachedSystemSettings: vi.fn(async () => ({
    verboseProviderError: false,
    passThroughUpstreamErrorMessage: false,
  })),
  updateMessageRequestDetailsDurably: vi.fn<typeof updateMessageRequestDetailsDurably>(),
  loggerWarn: vi.fn(),
}));

const ERROR_CATALOGS: Record<Locale, Record<string, string>> = {
  en: enErrors,
  ja: jaErrors,
  ru: ruErrors,
  "zh-CN": zhCnErrors,
  "zh-TW": zhTwErrors,
};

vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => "en"),
  getTranslations: vi.fn(async ({ locale }: { locale: Locale }) =>
    createTranslator({
      locale,
      messages: { errors: ERROR_CATALOGS[locale] },
      namespace: "errors",
    })
  ),
}));

vi.mock("@/lib/error-rule-detector", () => ({
  errorRuleDetector: { detectAsync: mocks.detectAsync },
}));

vi.mock("@/lib/config/system-settings-cache", () => ({
  getCachedSystemSettings: mocks.getCachedSystemSettings,
}));

vi.mock("@/lib/langfuse/emit-proxy-trace", () => ({
  emitProxyLangfuseTrace: mocks.emitProxyLangfuseTrace,
}));

vi.mock("@/repository/message", () => ({
  updateMessageRequestDetailsDurably: mocks.updateMessageRequestDetailsDurably,
}));

vi.mock("@/lib/proxy-status-tracker", () => ({
  ProxyStatusTracker: {
    getInstance: () => ({ endRequest: mocks.endRequest }),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: mocks.loggerWarn,
  },
}));

const FIXTURE_DATE = new Date("2026-01-01T00:00:00.000Z");

const USER = {
  id: 42,
  name: "test-user",
  description: "error-handler fixture",
  role: "user",
  rpm: null,
  dailyQuota: null,
  providerGroup: null,
  createdAt: FIXTURE_DATE,
  updatedAt: FIXTURE_DATE,
  limit5hResetMode: "fixed",
  dailyResetMode: "fixed",
  dailyResetTime: "00:00",
  isEnabled: true,
} satisfies User;

const KEY = {
  id: 8,
  userId: USER.id,
  name: "test-key",
  key: "sk-test-key",
  isEnabled: true,
  canLoginWebUi: false,
  limit5hUsd: null,
  limit5hResetMode: "fixed",
  limitDailyUsd: null,
  dailyResetMode: "fixed",
  dailyResetTime: "00:00",
  limitWeeklyUsd: null,
  limitMonthlyUsd: null,
  limitConcurrentSessions: 0,
  providerGroup: null,
  cacheTtlPreference: null,
  createdAt: FIXTURE_DATE,
  updatedAt: FIXTURE_DATE,
} satisfies Key;

async function createSession(): Promise<ProxySession> {
  const request = new Request("https://hub.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const session = await ProxySession.fromContext(new Context(request));
  session.setSessionId("s_durable");
  return session;
}

function attachMessageContext(session: ProxySession): void {
  session.setMessageContext({
    id: 901,
    createdAt: FIXTURE_DATE,
    user: USER,
    key: KEY,
    apiKey: KEY.key,
  });
}

describe("ProxyErrorHandler.handle durable persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLocale).mockResolvedValue("en");
    mocks.detectAsync.mockResolvedValue({ matched: false });
    mocks.getCachedSystemSettings.mockResolvedValue({
      verboseProviderError: false,
      passThroughUpstreamErrorMessage: false,
    });
    mocks.updateMessageRequestDetailsDurably.mockResolvedValue(undefined);
  });

  test.each(["en", "zh-CN", "zh-TW", "ja", "ru"] satisfies Locale[])(
    "localizes native client aborts for %s while persisting 499/CLIENT_ABORTED",
    async (locale) => {
      vi.mocked(getLocale).mockResolvedValue(locale);
      const session = await createSession();
      attachMessageContext(session);

      const response = await ProxyErrorHandler.handle(session, new DOMException("", "AbortError"));

      expect(response.status).toBe(499);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining(ERROR_CATALOGS[locale].CLIENT_ABORTED) },
      });
      expect(mocks.updateMessageRequestDetailsDurably).toHaveBeenCalledWith(
        901,
        expect.objectContaining({
          errorMessage: "CLIENT_ABORTED",
          statusCode: 499,
          providerChain: [],
        })
      );
      expect(mocks.emitProxyLangfuseTrace).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ errorMessage: "CLIENT_ABORTED", statusCode: 499 })
      );
    }
  );

  test("preserves native cancellation when request-locale lookup fails", async () => {
    vi.mocked(getLocale).mockRejectedValueOnce(new Error("request locale unavailable"));
    const session = await createSession();
    attachMessageContext(session);

    const response = await ProxyErrorHandler.handle(session, new DOMException("", "AbortError"));

    expect(response.status).toBe(499);
    expect(mocks.updateMessageRequestDetailsDurably).toHaveBeenCalledWith(
      901,
      expect.objectContaining({ errorMessage: "CLIENT_ABORTED", statusCode: 499 })
    );
  });

  test("does not localize an upstream HTTP 499 as a local cancellation", async () => {
    vi.mocked(getLocale).mockResolvedValue("zh-CN");
    const session = await createSession();
    attachMessageContext(session);
    const error = await ProxyError.fromUpstreamResponse(
      new Response(JSON.stringify({ error: { message: "Provider closed request" } }), {
        status: 499,
        headers: { "content-type": "application/json" },
      }),
      { id: 7, name: "provider-a" }
    );

    const response = await ProxyErrorHandler.handle(session, error);

    expect(response.status).toBe(499);
    expect(await response.json()).not.toMatchObject({
      error: { message: expect.stringContaining(zhCnErrors.CLIENT_ABORTED) },
    });
    expect(mocks.updateMessageRequestDetailsDurably).toHaveBeenCalledWith(
      901,
      expect.objectContaining({
        statusCode: 499,
        errorMessage: expect.stringContaining("Provider provider-a returned 499"),
      })
    );
  });

  test("logs a rejected live observability close without leaking an unhandled rejection", async () => {
    const session = await createSession();
    attachMessageContext(session);
    vi.spyOn(session, "closeLiveObservability").mockRejectedValueOnce(
      new Error("redis unavailable")
    );

    const response = await ProxyErrorHandler.handle(session, new Error("fetch failed"));

    expect(response.status).toBe(500);
    await vi.waitFor(() => {
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        "ProxyErrorHandler: Failed to close live observability",
        { error: "redis unavailable" }
      );
    });
  });

  test("emits the trace, awaits persistence, then ends status tracking", async () => {
    const commit = Promise.withResolvers<void>();
    mocks.updateMessageRequestDetailsDurably.mockReturnValueOnce(commit.promise);
    const session = await createSession();
    attachMessageContext(session);

    const handlePromise = ProxyErrorHandler.handle(session, new Error("fetch failed"));
    await vi.waitFor(() => expect(mocks.updateMessageRequestDetailsDurably).toHaveBeenCalledOnce());

    expect(mocks.emitProxyLangfuseTrace).toHaveBeenCalledOnce();
    expect(mocks.endRequest).not.toHaveBeenCalled();
    const traceOrder = mocks.emitProxyLangfuseTrace.mock.invocationCallOrder[0];
    const persistOrder = mocks.updateMessageRequestDetailsDurably.mock.invocationCallOrder[0];
    expect(traceOrder ?? Number.MAX_SAFE_INTEGER).toBeLessThan(persistOrder ?? -1);

    commit.resolve();
    const response = await handlePromise;

    expect(response.status).toBe(500);
    expect(mocks.updateMessageRequestDetailsDurably).toHaveBeenCalledWith(
      901,
      expect.objectContaining({
        durationMs: expect.any(Number),
        errorMessage: "fetch failed",
        providerChain: [],
        statusCode: 500,
        model: "claude-sonnet-4-20250514",
        context1mApplied: false,
        swapCacheTtlApplied: false,
      })
    );
    expect(mocks.endRequest).toHaveBeenCalledWith(USER.id, 901);
    const endOrder = mocks.endRequest.mock.invocationCallOrder[0];
    expect(persistOrder ?? Number.MAX_SAFE_INTEGER).toBeLessThan(endOrder ?? -1);
  });

  test("持久化失败保留 trace 和原始错误，并结束追踪及实时观测", async () => {
    mocks.updateMessageRequestDetailsDurably.mockRejectedValueOnce(new Error("db down"));
    const session = await createSession();
    attachMessageContext(session);

    const close = vi.spyOn(session, "closeLiveObservability").mockResolvedValueOnce(undefined);

    await expect(ProxyErrorHandler.handle(session, new Error("fetch failed"))).rejects.toThrow(
      "db down"
    );

    expect(mocks.emitProxyLangfuseTrace).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ statusCode: 500, errorMessage: "fetch failed" })
    );
    expect(mocks.endRequest).toHaveBeenCalledExactlyOnceWith(USER.id, 901);
    expect(close).toHaveBeenCalledOnce();
  });

  test("persists the final overridden status", async () => {
    mocks.detectAsync.mockResolvedValue({ matched: true, overrideStatusCode: 429 });
    const session = await createSession();
    attachMessageContext(session);
    const error = new ProxyError("Upstream failed", 502, {
      body: "Upstream failed",
      providerId: 7,
      providerName: "provider-a",
    });

    const response = await ProxyErrorHandler.handle(session, error);

    expect(response.status).toBe(429);
    expect(mocks.updateMessageRequestDetailsDurably).toHaveBeenCalledWith(
      901,
      expect.objectContaining({
        statusCode: 429,
        errorMessage: expect.stringContaining("Upstream"),
      })
    );
    expect(mocks.endRequest).toHaveBeenCalledWith(USER.id, 901);
  });

  test("skips persistence and tracking when no message context exists", async () => {
    const session = await createSession();

    const response = await ProxyErrorHandler.handle(session, new Error("fetch failed"));

    expect(response.status).toBe(500);
    expect(mocks.emitProxyLangfuseTrace).toHaveBeenCalledOnce();
    expect(mocks.updateMessageRequestDetailsDurably).not.toHaveBeenCalled();
    expect(mocks.endRequest).not.toHaveBeenCalled();
  });

  test("returns admission 503 without recursively waiting on durable persistence", async () => {
    const session = await createSession();
    attachMessageContext(session);
    const error = new DrizzleQueryError(
      "select * from keys where key = $1",
      ["sk-admission-canary"],
      new DbPoolAdmissionError("control", 32)
    );

    const response = await ProxyErrorHandler.handle(session, error);

    expect(response.status).toBe(503);
    expect(mocks.updateMessageRequestDetailsDurably).not.toHaveBeenCalled();
    expect(mocks.endRequest).toHaveBeenCalledWith(USER.id, 901);
  });
});
