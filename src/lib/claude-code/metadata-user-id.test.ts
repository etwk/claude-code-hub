import { describe, expect, test } from "vitest";
import {
  buildClaudeMetadataDeviceId,
  buildClaudeMetadataUserId,
  CLAUDE_CODE_METADATA_USER_ID_JSON_SWITCH_VERSION,
  hasUsableClaudeMetadataUserId,
  injectClaudeMetadataUserIdWithContext,
  parseClaudeMetadataUserId,
  resolveClaudeMetadataUserIdFormat,
} from "@/lib/claude-code/metadata-user-id";

const EMPTY_PARSE_RESULT = {
  sessionId: null,
  format: null,
  deviceId: null,
  accountUuid: null,
};

describe("Claude metadata.user_id helper", () => {
  test("解析旧格式 user_id 时应提取 sessionId 和 deviceId", () => {
    const userId =
      "user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_account__session_sess_legacy_123";

    expect(parseClaudeMetadataUserId(userId)).toEqual({
      sessionId: "sess_legacy_123",
      format: "legacy",
      deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      accountUuid: null,
    });
  });

  test("解析 JSON 字符串 user_id 时应提取 sessionId 和 deviceId", () => {
    const userId = JSON.stringify({
      device_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      account_uuid: "",
      session_id: "sess_json_123",
    });

    expect(parseClaudeMetadataUserId(userId)).toEqual({
      sessionId: "sess_json_123",
      format: "json",
      deviceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      accountUuid: "",
    });
  });

  test("解析 JSON 字符串 user_id 时应 trim sessionId", () => {
    const userId = JSON.stringify({
      device_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      account_uuid: "",
      session_id: "  sess_json_trimmed  ",
    });

    expect(parseClaudeMetadataUserId(userId)).toEqual({
      sessionId: "sess_json_trimmed",
      format: "json",
      deviceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      accountUuid: "",
    });
  });

  test("解析旧格式 user_id 时应 trim sessionId", () => {
    const userId =
      "user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_account__session_  sess_legacy_trimmed  ";

    expect(parseClaudeMetadataUserId(userId)).toEqual({
      sessionId: "sess_legacy_trimmed",
      format: "legacy",
      deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      accountUuid: null,
    });
  });

  test.each([
    ["UUID", "550e8400-e29b-41d4-a716-446655440000"],
    ["opaque token", "client.session:abc_123"],
    ["64-char token", "a".repeat(64)],
  ])("纯 %s user_id 应作为 sessionId 解析并视为可用", (_label, userId) => {
    expect(parseClaudeMetadataUserId(`  ${userId}  `)).toEqual({
      sessionId: userId,
      format: "plain",
      deviceId: null,
      accountUuid: null,
    });
    expect(hasUsableClaudeMetadataUserId(userId)).toBe(true);
  });

  test.each<[string, unknown]>([
    ["JSON without session_id", '{"device_id":"only"}'],
    ["JSON with blank session_id", '{"device_id":"only","session_id":"   "}'],
    ["malformed JSON", "{invalid-json"],
    ["JSON array", '["sess_in_array"]'],
    ["legacy with blank session", "user_abc_account__session_   "],
    ["legacy without device", "user__account__session_abc"],
    ["text with spaces", "invalid user id"],
    ["65-char token", "a".repeat(65)],
    ["JSON with 65-char session_id", JSON.stringify({ session_id: "a".repeat(65) })],
    ["number", 123],
    ["object", { session_id: "sess_object" }],
  ])("不可用的 user_id（%s）应返回空结果并允许补全", (_label, userId) => {
    expect(parseClaudeMetadataUserId(userId)).toEqual(EMPTY_PARSE_RESULT);
    expect(hasUsableClaudeMetadataUserId(userId)).toBe(false);

    const userAgent = "claude-cli/2.1.78 (external, cli)";
    const message = { metadata: { user_id: userId, source: "client" } };
    const result = injectClaudeMetadataUserIdWithContext(message, {
      keyId: 1,
      sessionId: "sess_completed",
      userAgent,
    });

    expect(result).not.toBe(message);
    expect(result.metadata).toEqual({
      source: "client",
      user_id: buildClaudeMetadataUserId({ keyId: 1, sessionId: "sess_completed", userAgent }),
    });
  });

  test("低于切换版本的 Claude Code 客户端应使用旧格式", () => {
    const keyId = 42;
    const sessionId = "sess_old_format";

    expect(resolveClaudeMetadataUserIdFormat("claude-cli/2.1.77 (external, cli)")).toBe("legacy");
    expect(
      buildClaudeMetadataUserId({
        keyId,
        sessionId,
        userAgent: "claude-cli/2.1.77 (external, cli)",
      })
    ).toBe(`user_${buildClaudeMetadataDeviceId(keyId)}_account__session_${sessionId}`);
  });

  test(`版本为 ${CLAUDE_CODE_METADATA_USER_ID_JSON_SWITCH_VERSION} 的客户端应使用 JSON 字符串`, () => {
    const keyId = 42;
    const sessionId = "sess_json_format";

    expect(resolveClaudeMetadataUserIdFormat("claude-cli/2.1.78 (external, cli)")).toBe("json");
    expect(
      JSON.parse(
        buildClaudeMetadataUserId({
          keyId,
          sessionId,
          userAgent: "claude-cli/2.1.78 (external, cli)",
        })
      )
    ).toEqual({
      device_id: buildClaudeMetadataDeviceId(keyId),
      account_uuid: "",
      session_id: sessionId,
    });
  });

  test("无法获取版本时应默认使用 JSON 字符串", () => {
    const keyId = 42;
    const sessionId = "sess_unknown_version";

    expect(resolveClaudeMetadataUserIdFormat(undefined)).toBe("json");
    expect(
      JSON.parse(
        buildClaudeMetadataUserId({
          keyId,
          sessionId,
        })
      )
    ).toEqual({
      device_id: buildClaudeMetadataDeviceId(keyId),
      account_uuid: "",
      session_id: sessionId,
    });
  });

  test("注入时应保留有效 metadata.user_id", () => {
    const message = {
      metadata: {
        user_id: "existing_user_id",
        source: "client",
      },
    };

    expect(
      injectClaudeMetadataUserIdWithContext(message, {
        keyId: 1,
        sessionId: "sess_should_not_override",
        userAgent: "claude-cli/2.1.78 (external, cli)",
      })
    ).toBe(message);
  });

  test("注入时遇到空白 metadata.user_id 应继续补全", () => {
    const message = {
      metadata: {
        user_id: "   ",
      },
    };

    const result = injectClaudeMetadataUserIdWithContext(message, {
      keyId: 1,
      sessionId: "sess_fill_blank",
      userAgent: "claude-cli/2.1.78 (external, cli)",
    });

    expect(result).not.toBe(message);
    expect(JSON.parse((result.metadata as Record<string, unknown>).user_id as string)).toEqual({
      device_id: buildClaudeMetadataDeviceId(1),
      account_uuid: "",
      session_id: "sess_fill_blank",
    });
  });
});
