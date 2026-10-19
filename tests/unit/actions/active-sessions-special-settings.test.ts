import { beforeEach, describe, expect, test, vi } from "vitest";
import { getSessionDetails } from "@/actions/active-sessions";
import type { SpecialSetting } from "@/types/special-settings";

const {
  getSessionMock,
  getSessionDetailsCacheMock,
  setSessionDetailsCacheMock,
  getSessionRequestCountMock,
  getSessionRequestBodyMock,
  getSessionMessagesMock,
  getSessionResponseMock,
  getSessionRequestHeadersMock,
  getSessionResponseHeadersMock,
  getSessionClientRequestMetaMock,
  getSessionUpstreamRequestMetaMock,
  getSessionUpstreamResponseMetaMock,
  getSessionSpecialSettingsMock,
  getSessionRequestPhaseSnapshotMock,
  getSessionResponsePhaseSnapshotMock,
  isSessionRequestOwnedByKeyMock,
  aggregateSessionStatsMock,
  aggregateMultipleSessionStatsMock,
  findSessionRequestLocatorMock,
  findAdjacentSessionRequestsMock,
  findMessageRequestAuditByIdMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionDetailsCacheMock: vi.fn(),
  setSessionDetailsCacheMock: vi.fn(),
  getSessionRequestCountMock: vi.fn(),
  getSessionRequestBodyMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  getSessionResponseMock: vi.fn(),
  getSessionRequestHeadersMock: vi.fn(),
  getSessionResponseHeadersMock: vi.fn(),
  getSessionClientRequestMetaMock: vi.fn(),
  getSessionUpstreamRequestMetaMock: vi.fn(),
  getSessionUpstreamResponseMetaMock: vi.fn(),
  getSessionSpecialSettingsMock: vi.fn(),
  getSessionRequestPhaseSnapshotMock: vi.fn(),
  getSessionResponsePhaseSnapshotMock: vi.fn(),
  isSessionRequestOwnedByKeyMock: vi.fn(),
  aggregateSessionStatsMock: vi.fn(),
  aggregateMultipleSessionStatsMock: vi.fn(),
  findSessionRequestLocatorMock: vi.fn(),
  findAdjacentSessionRequestsMock: vi.fn(),
  findMessageRequestAuditByIdMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/cache/session-cache", () => ({
  getActiveSessionsCache: vi.fn(() => null),
  setActiveSessionsCache: vi.fn(),
  getSessionDetailsCache: getSessionDetailsCacheMock,
  setSessionDetailsCache: setSessionDetailsCacheMock,
  clearActiveSessionsCache: vi.fn(),
  clearSessionDetailsCache: vi.fn(),
  clearAllSessionsQueryCache: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    getSessionRequestCount: getSessionRequestCountMock,
    getSessionRequestBody: getSessionRequestBodyMock,
    getSessionMessages: getSessionMessagesMock,
    getSessionResponse: getSessionResponseMock,
    getSessionRequestHeaders: getSessionRequestHeadersMock,
    getSessionResponseHeaders: getSessionResponseHeadersMock,
    getSessionClientRequestMeta: getSessionClientRequestMetaMock,
    getSessionUpstreamRequestMeta: getSessionUpstreamRequestMetaMock,
    getSessionUpstreamResponseMeta: getSessionUpstreamResponseMetaMock,
    getSessionSpecialSettings: getSessionSpecialSettingsMock,
    getSessionRequestPhaseSnapshot: getSessionRequestPhaseSnapshotMock,
    getSessionResponsePhaseSnapshot: getSessionResponsePhaseSnapshotMock,
    isSessionRequestOwnedByKey: isSessionRequestOwnedByKeyMock,
  },
}));

vi.mock("@/repository/message", () => ({
  aggregateSessionStats: aggregateSessionStatsMock,
  aggregateMultipleSessionStats: aggregateMultipleSessionStatsMock,
  findSessionRequestLocator: findSessionRequestLocatorMock,
  findAdjacentSessionRequests: findAdjacentSessionRequestsMock,
  findMessageRequestAuditById: findMessageRequestAuditByIdMock,
}));

describe("getSessionDetails - unified specialSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getSessionMock.mockResolvedValue({ user: { id: 1, role: "admin" } });
    getSessionDetailsCacheMock.mockReturnValue(null);

    aggregateSessionStatsMock.mockResolvedValue({
      sessionId: "sess_x",
      requestCount: 1,
      totalCostUsd: "0",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalDurationMs: 0,
      firstRequestAt: new Date(),
      lastRequestAt: new Date(),
      providers: [],
      models: [],
      userName: "u",
      userId: 1,
      keyName: "k",
      keyId: 1,
      userAgent: null,
      apiType: "chat",
      cacheTtlApplied: null,
    });
    aggregateMultipleSessionStatsMock.mockImplementation(async (sessionIds: string[]) => {
      const stats = await aggregateSessionStatsMock(sessionIds[0]);
      return stats ? [{ ...stats, sessionId: stats.sessionId ?? sessionIds[0] }] : [];
    });
    findSessionRequestLocatorMock.mockResolvedValue({
      requestId: 101,
      canonicalSessionId: "sess_x",
      sourceSessionId: "sess_x",
      requestSequence: 1,
      keyId: 1,
      userId: 1,
      identityKind: "session_id",
      scopeTag: null,
      fingerprint: null,
    });

    findAdjacentSessionRequestsMock.mockResolvedValue({ prevRequest: null, nextRequest: null });
    isSessionRequestOwnedByKeyMock.mockResolvedValue(true);

    getSessionRequestCountMock.mockResolvedValue(1);
    getSessionRequestBodyMock.mockResolvedValue(null);
    getSessionMessagesMock.mockResolvedValue(null);
    getSessionResponseMock.mockResolvedValue(null);
    getSessionRequestHeadersMock.mockResolvedValue(null);
    getSessionResponseHeadersMock.mockResolvedValue(null);
    getSessionClientRequestMetaMock.mockResolvedValue(null);
    getSessionUpstreamRequestMetaMock.mockResolvedValue(null);
    getSessionUpstreamResponseMetaMock.mockResolvedValue(null);
    getSessionRequestPhaseSnapshotMock.mockResolvedValue(null);
    getSessionResponsePhaseSnapshotMock.mockResolvedValue(null);
  });

  test("当 Redis specialSettings 为空时，应由 DB 审计字段派生特殊设置", async () => {
    getSessionSpecialSettingsMock.mockResolvedValue(null);
    findMessageRequestAuditByIdMock.mockResolvedValue({
      statusCode: 200,
      blockedBy: "warmup",
      blockedReason: JSON.stringify({ reason: "anthropic_warmup_intercepted" }),
      cacheTtlApplied: "1h",
      context1mApplied: true,
      specialSettings: null,
    });

    const result = await getSessionDetails("sess_x", 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const types = (result.data.specialSettings ?? []).map((s) => s.type).sort();
    expect(types).toEqual(["anthropic_cache_ttl_header_override", "guard_intercept"].sort());
    expect(isSessionRequestOwnedByKeyMock).toHaveBeenCalledWith("sess_x", 1, 1);
    expect(findMessageRequestAuditByIdMock).toHaveBeenCalledWith(101, 1);
  });

  test("当 Redis 与 DB 同时存在 specialSettings 时，应合并并去重", async () => {
    getSessionSpecialSettingsMock.mockResolvedValue([
      {
        type: "provider_parameter_override",
        scope: "provider",
        providerId: 1,
        providerName: "p",
        providerType: "codex",
        hit: true,
        changed: true,
        changes: [{ path: "temperature", before: 1, after: 0.2, changed: true }],
      },
    ]);

    findMessageRequestAuditByIdMock.mockResolvedValue({
      statusCode: 200,
      blockedBy: "warmup",
      blockedReason: JSON.stringify({ reason: "anthropic_warmup_intercepted" }),
      cacheTtlApplied: null,
      context1mApplied: false,
      specialSettings: [
        {
          type: "provider_parameter_override",
          scope: "provider",
          providerId: 1,
          providerName: "p",
          providerType: "codex",
          hit: true,
          changed: true,
          changes: [{ path: "temperature", before: 1, after: 0.2, changed: true }],
        },
      ],
    });

    const result = await getSessionDetails("sess_x", 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const settings = result.data.specialSettings ?? [];
    expect(settings.some((s) => s.type === "provider_parameter_override")).toBe(true);
    expect(settings.some((s) => s.type === "guard_intercept")).toBe(true);
    expect(settings.filter((s) => s.type === "provider_parameter_override").length).toBe(1);
  });

  const first: SpecialSetting = {
    type: "provider_parameter_override",
    scope: "provider",
    providerId: 1,
    providerName: "provider",
    providerType: "claude",
    hit: true,
    changed: true,
    changes: [{ path: "output_config.effort", before: "low", after: "high", changed: true }],
  };
  const second: SpecialSetting = {
    ...first,
    changes: [{ path: "output_config.effort", before: "high", after: "max", changed: true }],
  };
  const third: SpecialSetting = {
    ...first,
    changes: [{ path: "output_config.effort", before: "max", after: "medium", changed: true }],
  };

  test.each([
    {
      name: "identical A-B snapshots",
      redis: [first, second],
      database: [first, second],
      expected: [first, second],
    },
    {
      name: "a DB snapshot extending Redis",
      redis: [first, second],
      database: [first, second, third],
      expected: [first, second, third],
    },
    {
      name: "a Redis snapshot extending DB",
      redis: [first, second, third],
      database: [first, second],
      expected: [first, second, third],
    },
    {
      name: "partially overlapping snapshots",
      redis: [first, second],
      database: [second, third],
      expected: [first, second, third],
    },
    {
      name: "an event missing from Redis",
      redis: [first, third],
      database: [first, second, third],
      expected: [first, second, third],
    },
    {
      name: "a genuine A-B-A in both snapshots",
      redis: [first, second, first],
      database: [first, second, first],
      expected: [first, second, first],
    },
    {
      name: "a genuine A-B-A only in Redis",
      redis: [first, second, first],
      database: [first, second],
      expected: [first, second, first],
    },
    {
      name: "a genuine A-B-A only in DB",
      redis: [first, second],
      database: [first, second, first],
      expected: [first, second, first],
    },
  ])(
    "reconciles $name before chronological deduplication",
    async ({ redis, database, expected }) => {
      getSessionSpecialSettingsMock.mockResolvedValue(redis);
      findMessageRequestAuditByIdMock.mockResolvedValue({
        statusCode: 200,
        blockedBy: null,
        blockedReason: null,
        cacheTtlApplied: null,
        context1mApplied: false,
        specialSettings: JSON.parse(JSON.stringify(database)),
      });

      const result = await getSessionDetails("sess_x", 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.specialSettings).toEqual(expected);
    }
  );

  const observed = (providerId: number, budgetTokens: number | null): SpecialSetting => ({
    type: "native_thinking_forwarded",
    scope: "provider",
    hit: true,
    protocol: "gemini",
    providerId,
    config: budgetTokens === null ? null : { effort: null, mode: null, budgetTokens },
  });
  const stale = observed(1, 8192);
  const current = observed(2, 0);
  const removed = observed(2, null);

  test.each([
    {
      name: "live Redis ahead of an unfinished DB row",
      statusCode: null,
      redis: current,
      database: stale,
      expected: current,
    },
    {
      name: "a finalized DB row ahead of stale Redis",
      statusCode: 200,
      redis: stale,
      database: current,
      expected: current,
    },
    {
      name: "explicit removal in a finalized failed request",
      statusCode: 502,
      redis: stale,
      database: removed,
      expected: removed,
    },
    {
      name: "a finalized request without a forwarded observation",
      statusCode: 200,
      redis: stale,
      database: null,
      expected: null,
    },
  ])(
    "preserves authoritative configuration for $name",
    async ({ statusCode, redis, database, expected }) => {
      getSessionSpecialSettingsMock.mockResolvedValue([first, redis]);
      findMessageRequestAuditByIdMock.mockResolvedValue({
        statusCode,
        blockedBy: null,
        blockedReason: null,
        cacheTtlApplied: null,
        context1mApplied: false,
        specialSettings: [first, second, ...(database ? [database] : [])],
      });

      const result = await getSessionDetails("sess_x", 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const settings = result.data.specialSettings ?? [];
      expect(settings.filter((setting) => setting.type === "native_thinking_forwarded")).toEqual(
        expected ? [expected] : []
      );
      expect(settings.filter((setting) => setting.type === "provider_parameter_override")).toEqual([
        first,
        second,
      ]);
    }
  );
});
