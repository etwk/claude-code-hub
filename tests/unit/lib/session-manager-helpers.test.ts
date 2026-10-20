import { describe, expect, test, vi } from "vitest";

const loggerWarnMock = vi.fn();
const PARSE_HEADER_RECORD_WARN_MESSAGE = "SessionManager: Failed to parse header record JSON";

function getParseHeaderRecordWarnCalls(): unknown[][] {
  return loggerWarnMock.mock.calls.filter((call) => call[0] === PARSE_HEADER_RECORD_WARN_MESSAGE);
}

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: loggerWarnMock,
    trace: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const sanitizeHeadersMock = vi.fn();

vi.mock("@/app/v1/_lib/proxy/errors", () => ({
  sanitizeHeaders: sanitizeHeadersMock,
}));

async function loadHelpers() {
  const mod = await import("@/lib/session-manager");
  return {
    headersToSanitizedObject: mod.headersToSanitizedObject,
    parseHeaderRecord: mod.parseHeaderRecord,
    extractClientSessionId: mod.SessionManager.extractClientSessionId,
  };
}

describe("SessionManager 辅助函数", () => {
  test("parseHeaderRecord：有效 JSON 对象应解析为记录", async () => {
    vi.clearAllMocks();
    const { parseHeaderRecord } = await loadHelpers();

    expect(parseHeaderRecord('{"a":"1","b":"2"}')).toEqual({ a: "1", b: "2" });
    expect(getParseHeaderRecordWarnCalls()).toHaveLength(0);
  });

  test("parseHeaderRecord：空对象应返回空记录", async () => {
    vi.clearAllMocks();
    const { parseHeaderRecord } = await loadHelpers();

    expect(parseHeaderRecord("{}")).toEqual({});
    expect(getParseHeaderRecordWarnCalls()).toHaveLength(0);
  });

  test("parseHeaderRecord：只保留字符串值", async () => {
    vi.clearAllMocks();
    const { parseHeaderRecord } = await loadHelpers();

    expect(parseHeaderRecord('{"a":"1","b":2,"c":true,"d":null,"e":{},"f":[]}')).toEqual({
      a: "1",
    });
    expect(getParseHeaderRecordWarnCalls()).toHaveLength(0);
  });

  test("parseHeaderRecord：移除历史快照中的内部 x-cch header", async () => {
    vi.clearAllMocks();
    const { parseHeaderRecord } = await loadHelpers();

    expect(
      parseHeaderRecord(
        '{"x-cch-internal-secret":"secret-canary","x-cch-future-marker":"1","x-safe":"ok"}'
      )
    ).toEqual({ "x-safe": "ok" });
  });

  test("parseHeaderRecord：无效 JSON 应返回 null 并记录 warn", async () => {
    vi.clearAllMocks();
    const { parseHeaderRecord } = await loadHelpers();

    expect(parseHeaderRecord("{bad json")).toBe(null);
    const calls = getParseHeaderRecordWarnCalls();
    expect(calls).toHaveLength(1);

    const [message, meta] = calls[0] ?? [];
    expect(message).toBe("SessionManager: Failed to parse header record JSON");
    expect(meta).toEqual(expect.objectContaining({ error: expect.anything() }));
  });

  test("parseHeaderRecord：JSON 数组/null/原始值应返回 null", async () => {
    vi.clearAllMocks();
    const { parseHeaderRecord } = await loadHelpers();

    expect(parseHeaderRecord('["a"]')).toBe(null);
    expect(parseHeaderRecord("null")).toBe(null);
    expect(parseHeaderRecord("1")).toBe(null);
    expect(getParseHeaderRecordWarnCalls()).toHaveLength(0);
  });

  test("headersToSanitizedObject：单个 header 应正确转换", async () => {
    vi.clearAllMocks();
    const { headersToSanitizedObject } = await loadHelpers();

    const headers = new Headers({ "x-test": "1" });
    sanitizeHeadersMock.mockReturnValueOnce("x-test: 1");

    expect(headersToSanitizedObject(headers)).toEqual({ "x-test": "1" });
    expect(sanitizeHeadersMock).toHaveBeenCalledWith(headers);
  });

  test("headersToSanitizedObject：多个 header 应正确转换", async () => {
    vi.clearAllMocks();
    const { headersToSanitizedObject } = await loadHelpers();

    const headers = new Headers({ a: "1", b: "2" });
    sanitizeHeadersMock.mockReturnValueOnce("a: 1\nb: 2");

    expect(headersToSanitizedObject(headers)).toEqual({ a: "1", b: "2" });
    expect(sanitizeHeadersMock).toHaveBeenCalledWith(headers);
  });

  test("headersToSanitizedObject：空 Headers 应返回空对象", async () => {
    vi.clearAllMocks();
    const { headersToSanitizedObject } = await loadHelpers();

    const headers = new Headers();
    sanitizeHeadersMock.mockReturnValueOnce("(empty)");

    expect(headersToSanitizedObject(headers)).toEqual({});
    expect(sanitizeHeadersMock).toHaveBeenCalledWith(headers);
  });

  test("headersToSanitizedObject：值包含冒号时应保留完整值", async () => {
    vi.clearAllMocks();
    const { headersToSanitizedObject } = await loadHelpers();

    const headers = new Headers({ "x-test": "a:b:c" });
    sanitizeHeadersMock.mockReturnValueOnce("x-test: a:b:c");

    expect(headersToSanitizedObject(headers)).toEqual({ "x-test": "a:b:c" });
    expect(sanitizeHeadersMock).toHaveBeenCalledWith(headers);
  });

  test("extractClientSessionId：应兼容旧格式 metadata.user_id", async () => {
    vi.clearAllMocks();
    const { extractClientSessionId } = await loadHelpers();

    expect(
      extractClientSessionId({
        metadata: {
          user_id:
            "user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_account__session_sess_legacy_123",
        },
      })
    ).toBe("sess_legacy_123");
  });

  test("extractClientSessionId：应兼容 JSON 字符串 metadata.user_id", async () => {
    vi.clearAllMocks();
    const { extractClientSessionId } = await loadHelpers();

    expect(
      extractClientSessionId({
        metadata: {
          user_id: JSON.stringify({
            device_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            account_uuid: "",
            session_id: "sess_json_123",
          }),
        },
      })
    ).toBe("sess_json_123");
  });

  test("extractClientSessionId：无效 user_id 时应回退到 metadata.session_id", async () => {
    vi.clearAllMocks();
    const { extractClientSessionId } = await loadHelpers();

    expect(
      extractClientSessionId({
        metadata: {
          user_id: "invalid_user_id",
          session_id: "sess_fallback_123",
        },
      })
    ).toBe("sess_fallback_123");
  });

  test.each(["x-claude-code-session-id", "x-session-id", "session_id"])(
    "extractClientSessionId：非 Codex 请求应从 %s 请求头提取",
    async (headerName) => {
      const { extractClientSessionId } = await loadHelpers();
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      const headers = new Headers({ [headerName]: sessionId });

      expect(extractClientSessionId({ messages: [] }, headers)).toBe(sessionId);
      expect(
        extractClientSessionId({ metadata: { user_id: "user@example.com" }, messages: [] }, headers)
      ).toBe(sessionId);
    }
  );

  test("extractClientSessionId：无其他来源时应使用纯 metadata.user_id", async () => {
    const { extractClientSessionId } = await loadHelpers();
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";

    expect(extractClientSessionId({ metadata: { user_id: sessionId } }, new Headers())).toBe(
      sessionId
    );
  });

  test("extractClientSessionId：应按结构化 user_id > metadata.session_id > 请求头 > 纯 user_id 提取", async () => {
    const { extractClientSessionId } = await loadHelpers();
    const structuredUserId = JSON.stringify({
      device_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      account_uuid: "",
      session_id: "sess_structured",
    });
    const plainOnly = { metadata: { user_id: "sess_plain_user" } };
    const headers = new Headers({
      "x-claude-code-session-id": "sess_header_claude",
      "x-session-id": "sess_header_x",
      session_id: "sess_header_plain",
    });

    expect(
      extractClientSessionId(
        { metadata: { user_id: structuredUserId, session_id: "sess_metadata" } },
        headers
      )
    ).toBe("sess_structured");
    expect(
      extractClientSessionId(
        { metadata: { user_id: "sess_plain_user", session_id: "sess_metadata" } },
        headers
      )
    ).toBe("sess_metadata");
    expect(extractClientSessionId(plainOnly, headers)).toBe("sess_header_claude");

    headers.set("x-claude-code-session-id", "invalid session id");
    expect(extractClientSessionId(plainOnly, headers)).toBe("sess_header_x");

    headers.delete("x-session-id");
    expect(extractClientSessionId(plainOnly, headers)).toBe("sess_header_plain");

    headers.delete("session_id");
    expect(extractClientSessionId(plainOnly, headers)).toBe("sess_plain_user");
  });
});
