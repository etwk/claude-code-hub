import {
  detectUpstreamErrorFromSseOrJsonText,
  sanitizeErrorTextForDetail,
} from "@/lib/utils/upstream-error-detection";
import { ALL_PROVIDERS_UNAVAILABLE_MESSAGE } from "./errors";

export interface DeriveClientSafeUpstreamErrorMessageInput {
  rawText?: string;
  candidateMessage?: string;
  candidateMessages?: Array<string | undefined | null>;
  providerName?: string | null;
  forbiddenProviderLabels?: string[];
}

const MAX_CLIENT_ERROR_MESSAGE_CHARS = 240;
const ELLIPSIS = "...";
const DEFAULT_FORBIDDEN_PROVIDER_LABELS = [
  "anthropic",
  "openai",
  "gemini",
  "google",
  "vertex",
  "bedrock",
  "azure",
  "deepseek",
  "grok",
  "claude",
  "codex",
  "openrouter",
  "siliconflow",
  "dashscope",
  "qwen",
  "kimi",
];

const INTERNAL_ONLY_RE = new RegExp(
  `^(?:FAKE_200_[A-Z0-9_]+|MALFORMED_BUFFERED_JSON|EMPTY_RESPONSE|HTTP\\s+\\d{3}|No available providers?|No available provider endpoints|Vendor-type circuit is open|Provider concurrent (?:session )?limit reached(?:\\s*\\([^)]*\\))?|(?:供应商)?并发\\s*Session\\s*上限已达到[^\\n]*|Invalid upstream discovery response|Service temporarily unavailable|Internal configuration error|Stream content gate rejected upstream before first valid content(?:\\s*\\([^)]*\\))?|${ALL_PROVIDERS_UNAVAILABLE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`,
  "iu"
);
const PROVIDER_PREFIX_RE =
  /\bProvider\s+(?:returned\s+\d{3}\b|failed\s+to\s+respond\b|(?:streaming\s+response\s+idle|first\s+content|first-byte|response)\s+timeout\s*:|[\w.-]+(?:\s+returned|\s*:|\s+-))|供应商(?:流式响应静默|首个有效内容|首字节响应|响应)超时\s*:/iu;
// Reject both anchored-at-start and embedded raw JSON blobs; embedded JSON would otherwise
// leak provider-shaped payloads (e.g. `Bad request: {"error":{"message":"..."}}`).
const RAW_JSON_BLOB_ANCHORED_RE = /^[[{]/u;
const RAW_JSON_BLOB_EMBEDDED_RE = /[[{]\s*"[^"\n]{1,80}"\s*:/u;
// Replacement regexes use the /g flag so `String.prototype.replace` can strip every match.
// `String.prototype.replace` resets `lastIndex`, so these stay safe during normalization.
const URL_RE = /\bhttps?:\/\/[^\s"'<>()[\]]+/giu;
const DOMAIN_RE =
  /(?<![\w-]|\.[a-z0-9_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|app|dev|cloud|cn|co|uk|jp|ru|de|fr|us|example)(?![\w-]|\.[a-z0-9_-])(?::\d{2,5})?(?:[/?#][^\s"'<>()[\]]*)?/giu;
const HOSTLIKE_RE =
  /(?<![\w-]|\.[a-z0-9_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]{2,})(?![\w-]|\.[a-z0-9_-])(?::\d{2,5})?(?:[/?#][^\s"'<>()[\]]*)?/giu;
const MODEL_SEGMENT_PATTERN =
  "(?:\\d[\\d.]*[a-z]*|[a-z]{1,2}\\d[\\d.]*|opus|sonnet|haiku|pro|flash|ultra|nano|coder|chat|reasoner|reasoning|math|vl|plus|max|turbo|lite|mini|micro|preview|exp|experimental|latest|beta|alpha|vision|instruct|thinking|fast|embedding|embeddings|moderation|audio|image|imagen|realtime|live|search|rerank|distill|zero|base)";
const MODEL_IDENTIFIER_RE = new RegExp(
  `\\b(?:claude|gemini|deepseek|qwen|grok|kimi|codex)-(?:${MODEL_SEGMENT_PATTERN})(?:-(?:${MODEL_SEGMENT_PATTERN}))*(?![\\w-])`,
  "giu"
);
// stripping natural phrases like "Rate limit exceeded for this endpoint".
const INTERNAL_LABEL_RE =
  /\b(?:gateway|proxy|provider|vendor|region|shard|cluster|internal|router|route|endpoint|node|alpha|beta)(?:[-_./][\w.-]{2,}|:\d{2,5}(?:\/[^\s"'<>]*)?)\b/giu;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g;
const IPV6_RE =
  /(?:\[[0-9a-fA-F:]+\](?::\d{2,5})?|(?:\b[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b)/g;
const REQUEST_ID_RE =
  /\b(?:request[_ -]?id|x-request-id|req(?:uest)?[_ -]?id|trace[_ -]?id|cf-ray)\b\s*[:=]?\s*[A-Za-z0-9._:-]{3,}\b/giu;
const REQUEST_ID_TOKEN_RE = /\b(?:req|msg|chatcmpl|run|trace)_[A-Za-z0-9._-]{3,}\b/giu;
const KEY_VALUE_RE =
  /\b(?:api[_ -]?key|token|secret|password)\b\s*[:=]\s*(?:\[REDACTED(?:_KEY)?\]|\[JWT\]|\*\*\*|[A-Za-z0-9._-]{6,})/giu;
const API_KEY_SHAPE_RE = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/iu;

// Non-global counterparts used by `.test()` to avoid the lastIndex-state hazard of `/g` regexes.
const URL_TEST_RE = /\bhttps?:\/\/[^\s"'<>]+/iu;
const DOMAIN_TEST_RE =
  /(?<![\w-]|\.[a-z0-9_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|app|dev|cloud|cn|co|uk|jp|ru|de|fr|us|example)(?![\w-]|\.[a-z0-9_-])(?:\b|\/[^\s"'<>]*)/iu;
const HOSTLIKE_TEST_RE =
  /(?<![\w-]|\.[a-z0-9_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]{2,})(?::\d{2,5})?(?:\/[^\s"'<>]*)?(?![\w-]|\.[a-z0-9_-])/iu;
const IPV4_TEST_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/;
const IPV6_TEST_RE =
  /(?:\[[0-9a-fA-F:]+\](?::\d{2,5})?|(?:\b[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b)/;
const REQUEST_ID_TEST_RE =
  /\b(?:request[_ -]?id|x-request-id|req(?:uest)?[_ -]?id|trace[_ -]?id|cf-ray)\b\s*[:=]?\s*[A-Za-z0-9._:-]{3,}\b/iu;
const REQUEST_ID_TOKEN_TEST_RE = /\b(?:req|msg|chatcmpl|run|trace)_[A-Za-z0-9._-]{3,}\b/iu;
const INTERNAL_LABEL_TEST_RE =
  /\b(?:gateway|proxy|provider|vendor|region|shard|cluster|internal|router|route|endpoint|node|alpha|beta)(?:[-_./][\w.-]{2,}|:\d{2,5}(?:\/[^\s"'<>]*)?)\b/iu;

function isAscii(text: string): boolean {
  return [...text].every((char) => char.charCodeAt(0) <= 0x7f);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsRawJsonBlob(text: string): boolean {
  return RAW_JSON_BLOB_ANCHORED_RE.test(text) || RAW_JSON_BLOB_EMBEDDED_RE.test(text);
}

function hasForbiddenLabelInList(message: string, labels: string[]): boolean {
  const normalized = message.toLocaleLowerCase();
  return labels.some((label) => {
    const trimmed = label.trim();
    if (!trimmed) return false;
    const lower = trimmed.toLocaleLowerCase();
    if (lower.length <= 1) return false;

    const boundary =
      /^[\w.-]+$/u.test(trimmed) && isAscii(trimmed)
        ? new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "iu")
        : null;
    return boundary ? boundary.test(message) : normalized.includes(lower);
  });
}

function hasForbiddenProviderLabel(
  message: string,
  explicitLabels: string[],
  defaultLabels: string[]
): boolean {
  if (PROVIDER_PREFIX_RE.test(message)) return true;
  const explicitLowerSet = new Set(
    explicitLabels.map((label) => label.trim().toLocaleLowerCase()).filter(Boolean)
  );
  const messageWithoutModelIdentifiers = message.replace(MODEL_IDENTIFIER_RE, (match) =>
    explicitLowerSet.has(match.toLocaleLowerCase()) ? match : " "
  );
  return (
    hasForbiddenLabelInList(messageWithoutModelIdentifiers, explicitLabels) ||
    hasForbiddenLabelInList(messageWithoutModelIdentifiers, defaultLabels)
  );
}
function normalizeClientMessage(text: string): string {
  let sanitized = text.replace(URL_RE, " ").replace(DOMAIN_RE, " ").replace(HOSTLIKE_RE, " ");
  sanitized = sanitizeErrorTextForDetail(sanitized);

  sanitized = sanitized
    .replace(URL_RE, " ")
    .replace(DOMAIN_RE, " ")
    .replace(HOSTLIKE_RE, " ")
    .replace(IPV4_RE, " ")
    .replace(IPV6_RE, " ")
    .replace(REQUEST_ID_RE, " ")
    .replace(REQUEST_ID_TOKEN_RE, " ")
    .replace(INTERNAL_LABEL_RE, " ")
    .replace(KEY_VALUE_RE, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\b(?:request[_ -]?id|x-request-id|trace[_ -]?id)\b\s*[:=]?\s*$/giu, " ")
    .replace(/\s+\b(?:at|from|for|with|see)\b\s*(?:[,.;:，。；：]|$)/giu, " ")
    .replace(/\s*[,;，；]\s*/g, ", ")
    .replace(/\s*[:：]\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  sanitized = sanitized.replace(/^(?:error|message)\s*[:：]\s*/iu, "").trim();
  if (sanitized.length > MAX_CLIENT_ERROR_MESSAGE_CHARS) {
    const budget = MAX_CLIENT_ERROR_MESSAGE_CHARS - ELLIPSIS.length;
    sanitized = `${sanitized.slice(0, budget).trim()}${ELLIPSIS}`;
  }

  return sanitized;
}

function isUnsafeAfterRedaction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (!/^[\x20-\x7E]+$/.test(trimmed) || !/[A-Za-z]{2,}/.test(trimmed)) {
    return true;
  }
  if (
    URL_TEST_RE.test(trimmed) ||
    DOMAIN_TEST_RE.test(trimmed) ||
    HOSTLIKE_TEST_RE.test(trimmed) ||
    IPV4_TEST_RE.test(trimmed) ||
    IPV6_TEST_RE.test(trimmed)
  ) {
    return true;
  }
  if (REQUEST_ID_TEST_RE.test(trimmed) || REQUEST_ID_TOKEN_TEST_RE.test(trimmed)) return true;
  if (INTERNAL_LABEL_TEST_RE.test(trimmed)) return true;
  if (API_KEY_SHAPE_RE.test(trimmed)) return true;
  return false;
}

function deriveCandidateFromRawText(rawText: string | undefined): string | null {
  if (typeof rawText !== "string" || !rawText.trim()) return null;
  const detected = detectUpstreamErrorFromSseOrJsonText(rawText);
  if (!detected.isError || !detected.detail || detected.code === "FAKE_200_HTML_BODY") {
    return null;
  }
  return detected.detail;
}

export function deriveClientSafeUpstreamErrorMessage(
  input: DeriveClientSafeUpstreamErrorMessageInput
): string | null {
  const explicitLabels = [
    input.providerName ?? "",
    ...(input.forbiddenProviderLabels ?? []),
  ].filter(Boolean);
  const candidates = [
    deriveCandidateFromRawText(input.rawText),
    input.candidateMessage,
    ...(input.candidateMessages ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || INTERNAL_ONLY_RE.test(trimmed) || containsRawJsonBlob(trimmed)) {
      continue;
    }
    const textWithoutUrls = trimmed.replace(URL_RE, " ");
    if (
      hasForbiddenProviderLabel(textWithoutUrls, explicitLabels, DEFAULT_FORBIDDEN_PROVIDER_LABELS)
    ) {
      continue;
    }

    const normalized = normalizeClientMessage(trimmed);
    if (!normalized || INTERNAL_ONLY_RE.test(normalized) || containsRawJsonBlob(normalized)) {
      continue;
    }
    if (
      hasForbiddenProviderLabel(normalized, explicitLabels, DEFAULT_FORBIDDEN_PROVIDER_LABELS) ||
      isUnsafeAfterRedaction(normalized)
    ) {
      continue;
    }

    return normalized;
  }

  return null;
}
