import crypto from "node:crypto";
import { parseUserAgent } from "@/lib/ua-parser";
import { isVersionLess } from "@/lib/version";

export const CLAUDE_CODE_METADATA_USER_ID_JSON_SWITCH_VERSION = "2.1.78";

export type ClaudeMetadataUserIdFormat = "legacy" | "json" | "plain";

export type ClaudeMetadataUserIdParseResult = {
  sessionId: string | null;
  format: ClaudeMetadataUserIdFormat | null;
  deviceId: string | null;
  accountUuid: string | null;
};

type BuildClaudeMetadataUserIdArgs = {
  keyId: number;
  sessionId: string;
  userAgent?: string | null;
};

type InjectClaudeMetadataUserIdArgs = {
  keyId: number | null | undefined;
  sessionId: string | null | undefined;
  userAgent?: string | null;
};

const LEGACY_PATTERN = /^user_(.+?)_account__session_(.+)$/;
const LEGACY_PREFIX_PATTERN = /^user_.*_account__session_/;
// message_request / usage_ledger store session ids in varchar(64) columns.
const CLIENT_SESSION_ID_MAX_LENGTH = 64;
const CLIENT_SESSION_ID_PATTERN = /^[\w\-.:]+$/;
const CLAUDE_CODE_CLIENT_TYPES = new Set(["claude-cli", "claude-vscode", "claude-cli-unknown"]);

function emptyParseResult(): ClaudeMetadataUserIdParseResult {
  return {
    sessionId: null,
    format: null,
    deviceId: null,
    accountUuid: null,
  };
}

export function buildClaudeMetadataDeviceId(keyId: number): string {
  return crypto.createHash("sha256").update(`claude_user_${keyId}`).digest("hex");
}

/**
 * Normalize a client-supplied session identifier (metadata field, header, or plain user_id).
 * Returns null for values that cannot safely key Redis session state.
 */
export function normalizeClaudeClientSessionId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > CLIENT_SESSION_ID_MAX_LENGTH ||
    !CLIENT_SESSION_ID_PATTERN.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

/**
 * A user_id is usable exactly when a session id can be extracted from it, so injection
 * never preserves a value that session extraction would ignore.
 */
export function hasUsableClaudeMetadataUserId(userId: unknown): boolean {
  return parseClaudeMetadataUserId(userId).sessionId !== null;
}

export function resolveClaudeMetadataUserIdFormat(
  userAgent?: string | null
): ClaudeMetadataUserIdFormat {
  const clientInfo = parseUserAgent(userAgent);
  if (!clientInfo || !CLAUDE_CODE_CLIENT_TYPES.has(clientInfo.clientType)) {
    return "json";
  }

  return isVersionLess(clientInfo.version, CLAUDE_CODE_METADATA_USER_ID_JSON_SWITCH_VERSION)
    ? "legacy"
    : "json";
}

/**
 * Parse metadata.user_id in one of three forms:
 * - json: `{"device_id":"...","account_uuid":"...","session_id":"..."}`
 * - legacy: `user_{deviceId}_account__session_{sessionId}`
 * - plain: a bare session token such as a UUID
 * JSON-looking or legacy-prefixed values without a valid session id are never treated as plain.
 */
export function parseClaudeMetadataUserId(userId: unknown): ClaudeMetadataUserIdParseResult {
  if (typeof userId !== "string") {
    return emptyParseResult();
  }

  const trimmed = userId.trim();
  if (!trimmed) {
    return emptyParseResult();
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const parsedObj = parsed as Record<string, unknown>;
        const sessionId = normalizeClaudeClientSessionId(parsedObj.session_id);
        if (sessionId) {
          return {
            sessionId,
            format: "json",
            deviceId: typeof parsedObj.device_id === "string" ? parsedObj.device_id : null,
            accountUuid: typeof parsedObj.account_uuid === "string" ? parsedObj.account_uuid : null,
          };
        }
      }
    } catch {
      // Malformed JSON carries no session id.
    }
    return emptyParseResult();
  }

  const legacyMatch = trimmed.match(LEGACY_PATTERN);
  if (legacyMatch) {
    const [, deviceId, rawSessionId] = legacyMatch;
    const sessionId = normalizeClaudeClientSessionId(rawSessionId);
    if (sessionId) {
      return {
        sessionId,
        format: "legacy",
        deviceId: deviceId || null,
        accountUuid: null,
      };
    }
  }

  if (LEGACY_PREFIX_PATTERN.test(trimmed)) {
    return emptyParseResult();
  }

  const plainSessionId = normalizeClaudeClientSessionId(trimmed);
  if (!plainSessionId) {
    return emptyParseResult();
  }

  return {
    sessionId: plainSessionId,
    format: "plain",
    deviceId: null,
    accountUuid: null,
  };
}

export function buildClaudeMetadataUserId(args: BuildClaudeMetadataUserIdArgs): string {
  const deviceId = buildClaudeMetadataDeviceId(args.keyId);
  const format = resolveClaudeMetadataUserIdFormat(args.userAgent);

  if (format === "legacy") {
    return `user_${deviceId}_account__session_${args.sessionId}`;
  }

  return JSON.stringify({
    device_id: deviceId,
    account_uuid: "",
    session_id: args.sessionId,
  });
}

export function injectClaudeMetadataUserIdWithContext(
  message: Record<string, unknown>,
  args: InjectClaudeMetadataUserIdArgs
): Record<string, unknown> {
  const existingMetadata =
    typeof message.metadata === "object" && message.metadata !== null
      ? (message.metadata as Record<string, unknown>)
      : undefined;

  if (hasUsableClaudeMetadataUserId(existingMetadata?.user_id)) {
    return message;
  }

  if (args.keyId == null || !args.sessionId) {
    return message;
  }

  return {
    ...message,
    metadata: {
      ...existingMetadata,
      user_id: buildClaudeMetadataUserId({
        keyId: args.keyId,
        sessionId: args.sessionId,
        userAgent: args.userAgent,
      }),
    },
  };
}
